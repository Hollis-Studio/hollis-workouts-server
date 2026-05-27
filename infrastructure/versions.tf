terraform {
  required_version = ">= 1.5.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    # random provider removed: identity_jwt_secret is now a required var
    # (var.identity_jwt_secret) so it is supplied by the operator and MUST match
    # the secret Hollis Identity signs HS256 tokens with. A randomly generated
    # value here would silently break all JWT verification.
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = local.tags
  }
}
