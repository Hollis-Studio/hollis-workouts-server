# ---------------------------------------------------------------------------
# Data sources — existing shared infrastructure (NEVER managed by this stack)
# ---------------------------------------------------------------------------

data "aws_vpc" "shared" {
  id = var.vpc_id
}

# ---------------------------------------------------------------------------
# ECS security group (new — workouts-specific tasks)
# ---------------------------------------------------------------------------
resource "aws_security_group" "ecs" {
  name        = "${local.name}-ecs"
  description = "Workouts ECS tasks — ingress from shared ALB only"
  vpc_id      = data.aws_vpc.shared.id
}

resource "aws_vpc_security_group_ingress_rule" "ecs_from_alb" {
  security_group_id            = aws_security_group.ecs.id
  referenced_security_group_id = tolist(data.aws_lb.shared.security_groups)[0]
  ip_protocol                  = "tcp"
  from_port                    = 3002
  to_port                      = 3002
}

resource "aws_vpc_security_group_egress_rule" "ecs_all" {
  security_group_id = aws_security_group.ecs.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# ---------------------------------------------------------------------------
# ADDITIVE RDS security group rule
#
# This resource appends a single ingress rule to the EXISTING RDS security
# group (sg-072f4e44c43356914).  It uses aws_security_group_rule (not
# aws_security_group), so Terraform never takes ownership of the SG or its
# existing rules — it only adds this one rule.  Removing this stack removes
# only this rule; all other rules on the SG remain intact.
# ---------------------------------------------------------------------------
resource "aws_security_group_rule" "rds_from_workouts_ecs" {
  description              = "Allow workouts ECS tasks to reach hollis-prod-postgres on 5432"
  type                     = "ingress"
  security_group_id        = var.rds_security_group_id
  source_security_group_id = aws_security_group.ecs.id
  protocol                 = "tcp"
  from_port                = 5432
  to_port                  = 5432
}
