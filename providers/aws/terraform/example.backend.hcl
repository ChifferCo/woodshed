# Where an installation's Terraform state lives, passed with -backend-config (providers/aws/README.md, "Setting it up"). The bucket is
# made by hand, once, before the first init. Keep it in the installation's own repo, such as .woodshed/install/aws/.
bucket       = "your-tfstate-bucket"
key          = "woodshed-cloud/terraform.tfstate"
region       = "us-east-1"
use_lockfile = true
encrypt      = true
