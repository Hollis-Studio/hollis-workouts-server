output "aws_account_id" {
  description = "AWS account ID of the caller identity."
  value       = data.aws_caller_identity.current.account_id
}

output "ecr_repository_url" {
  description = "ECR URL to push the workouts server container image to."
  value       = aws_ecr_repository.workouts.repository_url
}

output "target_group_arn" {
  description = "ARN of the new workouts ALB target group."
  value       = aws_lb_target_group.workouts.arn
}

output "ecs_service_name" {
  description = "ECS service name."
  value       = aws_ecs_service.workouts.name
}

output "database_url_secret_arn" {
  description = "ARN of the Secrets Manager secret containing DATABASE_URL."
  value       = aws_secretsmanager_secret.database_url.arn
  sensitive   = true
}

output "identity_jwt_secret_arn" {
  description = "ARN of the Secrets Manager secret containing IDENTITY_JWT_SECRET."
  value       = aws_secretsmanager_secret.identity_jwt_secret.arn
  sensitive   = true
}

output "identity_service_url_secret_arn" {
  description = "ARN of the Secrets Manager secret containing IDENTITY_SERVICE_URL."
  value       = aws_secretsmanager_secret.identity_service_url.arn
  sensitive   = true
}

output "alb_listener_rule_arn" {
  description = "ARN of the new workouts ALB listener rule (additive — does not modify Health's rules)."
  value       = aws_lb_listener_rule.workouts_host.arn
}

output "database_ssl_ca_secret_arn" {
  description = "ARN of the Secrets Manager secret containing the RDS PEM CA bundle (DATABASE_SSL_CA)."
  value       = aws_secretsmanager_secret.database_ssl_ca.arn
  sensitive   = true
}
