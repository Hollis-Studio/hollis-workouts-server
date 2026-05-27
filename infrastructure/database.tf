# ---------------------------------------------------------------------------
# Data source — existing shared RDS instance (read-only reference)
# This stack NEVER manages aws_db_instance.shared; it only reads its
# address and port so they can be used in the DATABASE_URL secret and
# the additive SG rule in network.tf.
# ---------------------------------------------------------------------------
data "aws_db_instance" "shared" {
  db_instance_identifier = var.rds_identifier
}

# ---------------------------------------------------------------------------
# Dedicated RDS instance (opt-in via create_dedicated_db = true)
#
# Default: false — the workouts service shares hollis-prod-postgres.
# Set create_dedicated_db = true in tfvars if you need a fully isolated
# database instance (e.g., for compliance, independent scaling, or after
# the shared instance becomes a bottleneck).
#
# When enabled, you must also update the database_url secret above to point
# at this instance rather than the shared one.
# ---------------------------------------------------------------------------
resource "aws_db_subnet_group" "workouts" {
  count      = var.create_dedicated_db ? 1 : 0
  name       = local.name
  subnet_ids = var.private_subnet_ids
}

resource "aws_security_group" "db" {
  count       = var.create_dedicated_db ? 1 : 0
  name        = "${local.name}-db"
  description = "Workouts dedicated Postgres"
  vpc_id      = data.aws_vpc.shared.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_ecs" {
  count                        = var.create_dedicated_db ? 1 : 0
  security_group_id            = aws_security_group.db[0].id
  referenced_security_group_id = aws_security_group.ecs.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_db_instance" "workouts" {
  count                 = var.create_dedicated_db ? 1 : 0
  identifier            = local.name
  engine                = "postgres"
  engine_version        = "15"
  instance_class        = "db.t3.micro"
  allocated_storage     = 20
  max_allocated_storage = 100
  db_name               = local.db_name
  username              = "hollis_workouts"
  # Password managed externally; rotate via Secrets Manager rotation.
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.workouts[0].name
  vpc_security_group_ids      = [aws_security_group.db[0].id]
  publicly_accessible         = false
  storage_encrypted           = true
  multi_az                    = var.environment == "prod"
  deletion_protection         = var.environment == "prod"
  skip_final_snapshot         = var.environment != "prod"
  backup_retention_period     = var.environment == "prod" ? 14 : 3
  apply_immediately           = var.environment != "prod"
}
