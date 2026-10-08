output "edge_ip" {
  description = "Static IP for the edge Service (Service.spec.loadBalancerIP) — and the target of the DNS records."
  value       = google_compute_address.edge.address
}

output "get_credentials" {
  value = "gcloud container clusters get-credentials ${google_container_cluster.lab.name} --zone ${var.zone} --project ${var.project_id}"
}

output "domain" {
  value = var.domain
}
