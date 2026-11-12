# Where an installation's Terraform state lives, passed with -backend-config (providers/aws/README.md, "Setting it up"). The bucket is
# made by hand, once, before the first init. Keep it in the installation's own repo, such as .woodshed/install/aws/.
# The deploy workflow's plan role takes the state's lock only at <name_prefix>-tfstate-<account id> and
# <name_prefix>/terraform.tfstate, unless the tfvars name these in tfstate_bucket and tfstate_key.
bucket       = "woodshed-tfstate-<account id>"
key          = "woodshed/terraform.tfstate"
region       = "us-east-1"
use_lockfile = true
encrypt      = true
