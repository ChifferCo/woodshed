# Each person's saved Claude home, between their My Woodshed sessions: MCP logins, memory, settings and
# transcripts, one gzipped tar per GitHub login (providers/aws/homeStore.mjs). Real S3, unlike a shared fake S3:
# the console's role alone reaches it, and sessions only ever see their own owner's, through the console.

resource "aws_s3_bucket" "homes" {
  bucket        = "woodshed-cloud-homes-${local.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "homes" {
  bucket                  = aws_s3_bucket.homes.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "homes" {
  bucket = aws_s3_bucket.homes.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "homes" {
  bucket = aws_s3_bucket.homes.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
