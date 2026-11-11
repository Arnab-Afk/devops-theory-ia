#!/bin/bash
# Single-node k3s. Rendered by Terraform (public_ip is the Elastic IP).
# Traefik is disabled so the gateway's LoadBalancer service gets port 80.
# k3s ships metrics-server (needed by the HPA) and a service load balancer.
set -euxo pipefail
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="v1.33.4+k3s1" \
  INSTALL_K3S_EXEC="server --disable traefik --tls-san ${public_ip} --write-kubeconfig-mode 644" sh -
until [ -f /etc/rancher/k3s/k3s.yaml ]; do sleep 2; done
# Ready-to-copy kubeconfig pointing at the public IP
sed "s/127.0.0.1/${public_ip}/" /etc/rancher/k3s/k3s.yaml > /home/ubuntu/kubeconfig
chown ubuntu:ubuntu /home/ubuntu/kubeconfig
