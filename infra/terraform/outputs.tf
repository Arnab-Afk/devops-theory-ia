output "public_ip" {
  value = aws_eip.node.public_ip
}

output "app_url" {
  value = "http://${aws_eip.node.public_ip}"
}

output "ecr_registry" {
  value = split("/", aws_ecr_repository.app["rate-limit-api"].repository_url)[0]
}

output "region" {
  value = var.region
}

output "ssh" {
  value = "ssh -i infra/terraform/${var.project}-key.pem ubuntu@${aws_eip.node.public_ip}"
}
