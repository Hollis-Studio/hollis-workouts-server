# ---------------------------------------------------------------------------
# Data sources — existing shared infrastructure (NEVER managed by this stack)
# ---------------------------------------------------------------------------

data "aws_ecs_cluster" "shared" {
  cluster_name = var.ecs_cluster_name
}

data "aws_lb" "shared" {
  name = var.alb_name
}

# Reference the HTTPS listener (port 443) on the shared ALB.
# This stack creates only an aws_lb_listener_rule attached to this listener —
# it never creates, modifies, or destroys the listener itself.
data "aws_lb_listener" "https" {
  load_balancer_arn = data.aws_lb.shared.arn
  port              = 443
}

resource "aws_lb_listener_certificate" "workouts_hosts" {
  listener_arn    = data.aws_lb_listener.https.arn
  certificate_arn = var.certificate_arn
}

# ---------------------------------------------------------------------------
# IAM — dedicated execution and task roles (do NOT share with Health's roles)
# ---------------------------------------------------------------------------

resource "aws_iam_role" "task_execution" {
  name = "${local.name}-task-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  name = "${local.name}-secrets"
  role = aws_iam_role.task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "secretsmanager:GetSecretValue"
      ]
      Resource = [
        aws_secretsmanager_secret.database_url.arn,
        aws_secretsmanager_secret.identity_jwt_secret.arn,
        aws_secretsmanager_secret.identity_service_url.arn,
        aws_secretsmanager_secret.database_ssl_ca.arn,
        aws_secretsmanager_secret.sentry_dsn.arn,
        aws_secretsmanager_secret.revenuecat_rest_api_key.arn,
        aws_secretsmanager_secret.google_cloud_project.arn,
        aws_secretsmanager_secret.gemini_api_key.arn,
        aws_secretsmanager_secret.google_application_credentials_json.arn,
      ]
    }]
  })
}

resource "aws_iam_role" "task" {
  name = "${local.name}-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

# ---------------------------------------------------------------------------
# ALB target group (new — workouts-specific)
# ---------------------------------------------------------------------------

resource "aws_lb_target_group" "workouts" {
  name        = local.name
  port        = 3002
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = data.aws_vpc.shared.id

  health_check {
    enabled             = true
    path                = "/healthz"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# ---------------------------------------------------------------------------
# ALB listener rule (new — ADDITIVE only)
#
# Attaches to the existing HTTPS listener via data source; only adds a
# host-based routing rule.  Terraform never owns the listener default_action
# and cannot modify or destroy Health's rules.
# ---------------------------------------------------------------------------

resource "aws_lb_listener_rule" "workouts_host" {
  listener_arn = data.aws_lb_listener.https.arn
  # Priority 200 — leaves room below 200 for Health rules and above 200 for
  # future additions.  Adjust if hollis-prod-alb already has a rule at 200.
  priority = 200

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.workouts.arn
  }

  condition {
    host_header {
      values = [var.workouts_domain_name]
    }
  }
}

# ---------------------------------------------------------------------------
# ECS task definition
# Mirrors ops/ecs-task-def.json but replaces all PLACEHOLDER values with
# Terraform-managed references.
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "workouts" {
  family                   = local.name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "workouts-server"
    image     = "${aws_ecr_repository.workouts.repository_url}:${var.image_tag}"
    essential = true

    portMappings = [{
      containerPort = 3002
      protocol      = "tcp"
    }]

    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "3002" },
      { name = "AUDIENCE", value = "hollis-workouts" },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "LOG_LEVEL", value = var.log_level },
      # Vertex AI / Gemini — non-secret config (model names + location)
      { name = "GOOGLE_CLOUD_LOCATION", value = var.google_cloud_location },
      { name = "GEMINI_FLASH_MODEL", value = var.gemini_flash_model },
      { name = "GEMINI_PRO_MODEL", value = var.gemini_pro_model },
      { name = "GEMINI_EMBEDDING_MODEL", value = var.gemini_embedding_model },
    ]

    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
      { name = "IDENTITY_JWT_SECRET", valueFrom = aws_secretsmanager_secret.identity_jwt_secret.arn },
      { name = "IDENTITY_SERVICE_URL", valueFrom = aws_secretsmanager_secret.identity_service_url.arn },
      { name = "DATABASE_SSL_CA", valueFrom = aws_secretsmanager_secret.database_ssl_ca.arn },
      # Error tracking (optional — Sentry SDK is a no-op when DSN is absent)
      { name = "SENTRY_DSN", valueFrom = aws_secretsmanager_secret.sentry_dsn.arn },
      # Entitlements (optional — RevenueCat check is bypassed when unset)
      { name = "REVENUECAT_REST_API_KEY", valueFrom = aws_secretsmanager_secret.revenuecat_rest_api_key.arn },
      # Vertex AI ADC — project ID and the full service-account key JSON.
      # ops/entrypoint.sh writes the JSON to /tmp/gcp-sa.json and sets
      # GOOGLE_APPLICATION_CREDENTIALS so the SDK picks it up automatically.
      { name = "GOOGLE_CLOUD_PROJECT", valueFrom = aws_secretsmanager_secret.google_cloud_project.arn },
      { name = "GEMINI_API_KEY", valueFrom = aws_secretsmanager_secret.gemini_api_key.arn },
      { name = "GOOGLE_APPLICATION_CREDENTIALS_JSON", valueFrom = aws_secretsmanager_secret.google_application_credentials_json.arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.workouts.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])
}

# ---------------------------------------------------------------------------
# ECS service — joins the existing cluster; routes via the new TG + rule
# ---------------------------------------------------------------------------

resource "aws_ecs_service" "workouts" {
  name            = local.name
  cluster         = data.aws_ecs_cluster.shared.arn
  task_definition = aws_ecs_task_definition.workouts.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  # Public subnets + public IP (egress via IGW), matching hollis-prod-api. The
  # private subnets have no NAT/VPC endpoints, so tasks there can't reach
  # Secrets Manager/ECR. The ECS SG only allows ingress from the shared ALB,
  # so the public IP is egress-only.
  network_configuration {
    subnets          = var.public_subnet_ids
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.workouts.arn
    container_name   = "workouts-server"
    container_port   = 3002
  }

  depends_on = [aws_lb_listener_rule.workouts_host]
}
