# ---------------------------------------------------------------------------
# GitHub Actions deploy role (OIDC)
#
# Mirrors the hollis-health-app `github-actions-deploy-role`: a narrow,
# OIDC-assumed role that lets the `.github/workflows/deploy.yml` workflow push
# images to the Workouts ECR repo and roll the Workouts ECS service. It has NO
# infrastructure-provisioning permissions (that stays with a human running
# `terraform apply`).
#
# The GitHub OIDC provider already exists in this account (created for
# hollis-health-app), so we reference it via a data source rather than create a
# second one. Trust is restricted to main-branch pushes of THIS repo only.
#
# After `terraform apply`, wire the role ARN into the repo:
#   ARN=$(terraform output -raw github_actions_deploy_role_arn)
#   gh secret set AWS_DEPLOY_APP_ROLE_ARN -R Hollis-Studio/hollis-workouts-server -b "$ARN"
# ---------------------------------------------------------------------------

# The org/repo allowed to assume the role (main branch only). Override if the
# repo is renamed or moved.
variable "github_deploy_repo" {
  description = "GitHub owner/repo permitted to assume the deploy role via OIDC."
  type        = string
  default     = "Hollis-Studio/hollis-workouts-server"
}

# Existing GitHub OIDC provider (shared across the account).
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "github_actions_deploy" {
  name = "${local.name}-github-actions-deploy-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = data.aws_iam_openid_connect_provider.github.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            # The deploy job runs with `environment: production`, so GitHub's
            # OIDC token subject is `repo:<repo>:environment:production` (NOT the
            # `:ref:refs/heads/main` form). Allow both: the environment subject
            # the job actually presents, plus the main-branch ref for any step
            # that runs outside the environment. Scoped to this repo only — no
            # PRs or arbitrary branches. (health-app uses a broader
            # `repo:org/*:*`; this is the tighter, repo-scoped equivalent.)
            "token.actions.githubusercontent.com:sub" = [
              "repo:${var.github_deploy_repo}:environment:production",
              "repo:${var.github_deploy_repo}:ref:refs/heads/main",
            ]
          }
        }
      }
    ]
  })

  tags = {
    Name    = "${local.name}-github-actions-deploy-role"
    Purpose = "Narrow CD role - ECR push + ECS roll only - no infra provisioning"
  }
}

resource "aws_iam_role_policy" "github_actions_deploy" {
  name = "${local.name}-github-actions-deploy-policy"
  role = aws_iam_role.github_actions_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # ECR auth token is account-scoped and cannot be resource-restricted.
      {
        Sid      = "ECRAuth"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      # ECR push/pull — scoped to the Workouts repository only.
      {
        Sid    = "ECRPushPull"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
          "ecr:DescribeRepositories",
          "ecr:DescribeImages",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage"
        ]
        Resource = aws_ecr_repository.workouts.arn
      },
      # ECS rollout. RegisterTaskDefinition cannot be resource-scoped; the rest
      # are read/update operations the deploy workflow performs.
      {
        Sid    = "ECSDeploy"
        Effect = "Allow"
        Action = [
          "ecs:RegisterTaskDefinition",
          "ecs:DescribeTaskDefinition",
          "ecs:UpdateService",
          "ecs:DescribeServices",
          "ecs:DescribeClusters",
          "ecs:ListTasks",
          "ecs:DescribeTasks"
        ]
        Resource = "*"
      },
      # PassRole — only the two roles the task definition actually uses.
      {
        Sid    = "PassRoleToECS"
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = [
          aws_iam_role.task_execution.arn,
          aws_iam_role.task.arn
        ]
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      }
    ]
  })
}

output "github_actions_deploy_role_arn" {
  description = "ARN to set as the AWS_DEPLOY_APP_ROLE_ARN GitHub Actions secret."
  value       = aws_iam_role.github_actions_deploy.arn
}
