data "aws_vpc" "default" {
  default = true
}

# Not every AZ offers every instance type, so place the node in one that does
data "aws_ec2_instance_type_offerings" "node" {
  location_type = "availability-zone"
  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }
}

data "aws_subnets" "node" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "availability-zone"
    values = data.aws_ec2_instance_type_offerings.node.locations
  }
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
}

# ---------- Container registry ----------
resource "aws_ecr_repository" "app" {
  for_each             = toset(["rate-limit-api", "rate-limit-gateway"])
  name                 = each.key
  force_delete         = true
  image_tag_mutability = "MUTABLE"
}

# ---------- SSH key (private key saved next to this file, gitignored) ----------
resource "tls_private_key" "ssh" {
  algorithm = "ED25519"
}

resource "aws_key_pair" "node" {
  key_name   = "${var.project}-key"
  public_key = tls_private_key.ssh.public_key_openssh
}

resource "local_sensitive_file" "ssh_key" {
  filename        = "${path.module}/${var.project}-key.pem"
  content         = tls_private_key.ssh.private_key_openssh
  file_permission = "0600"
}

# ---------- Kubernetes node (k3s on EC2) ----------
resource "aws_security_group" "node" {
  name        = "${var.project}-k3s"
  description = "k3s node: web traffic, SSH and Kubernetes API"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP: gateway (dashboard + API)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }
  ingress {
    description = "Kubernetes API (kubectl)"
    from_port   = 6443
    to_port     = 6443
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Fixed public IP so the kubeconfig and the TLS certificate survive instance stop/start
resource "aws_eip" "node" {
  domain = "vpc"
}

resource "aws_instance" "node" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = aws_key_pair.node.key_name
  vpc_security_group_ids = [aws_security_group.node.id]
  subnet_id              = data.aws_subnets.node.ids[0]

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  user_data = templatefile("${path.module}/k3s-userdata.sh", { public_ip = aws_eip.node.public_ip })

  tags = { Name = "${var.project}-k3s" }
}

resource "aws_eip_association" "node" {
  instance_id   = aws_instance.node.id
  allocation_id = aws_eip.node.id
}
