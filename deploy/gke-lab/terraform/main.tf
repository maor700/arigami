# An isolated lab for Arigami's multi-tenant control plane on GKE.
#
# What this encodes (learned the hard way, see ../README.md):
#   - its own VPC: nothing here can reach, or be reached from, the rest of the project's networks
#   - NetworkPolicy ENFORCED from the start (a cluster created without it ignores every policy silently:
#     tenants could talk to each other while `kubectl get networkpolicy` looked fine)
#   - a static regional IP + wildcard DNS, so the public address survives the load balancer being recreated
#   - an on-demand node pool, not Spot
#   - the Kubernetes API restricted to `authorized_cidrs`

locals {
  expires = formatdate("YYYYMMDD'T'hhmmss'Z'", timeadd(timestamp(), "${var.ttl_hours}h"))
}

resource "google_compute_network" "lab" {
  name                    = "${var.name}-net"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "lab" {
  name          = "${var.name}-subnet"
  region        = var.region
  network       = google_compute_network.lab.id
  ip_cidr_range = "10.200.0.0/20"

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.201.0.0/16"
  }
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.202.0.0/20"
  }
}

resource "google_compute_address" "edge" {
  name   = "${var.name}-ip"
  region = var.region
}

resource "google_container_cluster" "lab" {
  name     = var.name
  location = var.zone

  network    = google_compute_network.lab.id
  subnetwork = google_compute_subnetwork.lab.id

  # The default pool is created and removed; ours is managed below so changing it never recreates the cluster.
  remove_default_node_pool = true
  initial_node_count       = 1
  deletion_protection      = false # a lab: `terraform destroy` must work

  release_channel {
    channel = "REGULAR"
  }

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  # Without this the tenant NetworkPolicies are objects nobody enforces.
  network_policy {
    enabled  = true
    provider = "CALICO"
  }
  addons_config {
    network_policy_config {
      disabled = false
    }
  }

  master_authorized_networks_config {
    dynamic "cidr_blocks" {
      for_each = var.authorized_cidrs
      content {
        cidr_block   = cidr_blocks.value
        display_name = "lab-admin"
      }
    }
  }

  resource_labels = {
    purpose = var.name
    expires = lower(local.expires)
  }

  lifecycle {
    ignore_changes = [resource_labels["expires"]]
  }
}

resource "google_container_node_pool" "main" {
  name       = "main"
  location   = var.zone
  cluster    = google_container_cluster.lab.name
  node_count = var.node_count

  node_config {
    machine_type = var.node_machine_type
    disk_size_gb = var.node_disk_gb
    disk_type    = "pd-balanced"
    labels       = { pool = "main" }
  }
}

# The apex serves the control plane, the wildcard the tenants.
resource "google_dns_record_set" "apex" {
  count        = var.dns_zone_name == "" ? 0 : 1
  managed_zone = var.dns_zone_name
  name         = "${var.domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_address.edge.address]
}

resource "google_dns_record_set" "wildcard" {
  count        = var.dns_zone_name == "" ? 0 : 1
  managed_zone = var.dns_zone_name
  name         = "*.${var.domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_address.edge.address]
}
