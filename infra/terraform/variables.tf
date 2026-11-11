variable "region" {
  type    = string
  default = "us-east-1"
}

variable "project" {
  type    = string
  default = "rate-limit-demo"
}

variable "instance_type" {
  description = "2 vCPU / 8 GB is enough for Redis, 3-6 API pods and the gateway. m7i-flex.large is allowed on the AWS Free plan"
  type        = string
  default     = "m7i-flex.large"
}

variable "admin_cidr" {
  description = "Who may reach SSH (22) and the Kubernetes API (6443). Use <your-ip>/32 to restrict"
  type        = string
  default     = "0.0.0.0/0"
}
