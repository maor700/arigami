variable "project_id" {
  description = "GCP project that will own the lab (an isolated, non-production project is the point)."
  type        = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "zone" {
  description = "Zonal cluster: the control plane is free of the cluster-management fee for one zonal cluster, and a PVC is zonal anyway."
  type        = string
  default     = "us-central1-a"
}

variable "name" {
  description = "Name prefix for everything created here."
  type        = string
  default     = "arigami-lab"
}

variable "domain" {
  description = "Public hostname the lab answers on (e.g. lab.example.com). The apex serves the control plane, *.<domain> the tenants (u-<id>.<domain>)."
  type        = string
}

variable "dns_zone_name" {
  description = "Name of an EXISTING Cloud DNS managed zone that contains `domain`. Leave empty to skip the DNS records (create them by hand against the output IP)."
  type        = string
  default     = ""
}

variable "authorized_cidrs" {
  description = "CIDRs allowed to reach the Kubernetes API (the machine that runs kubectl/helm and the control plane). Required: an open API server is never the default."
  type        = list(string)
}

variable "node_machine_type" {
  description = "On-demand machine type for the single node pool. Spot nodes are preempted without warning and take the edge proxy (and its certificate) with them — use them only for throwaway tenants."
  type        = string
  default     = "n2d-standard-8"
}

variable "node_count" {
  type    = number
  default = 1
}

variable "node_disk_gb" {
  type    = number
  default = 100
}

variable "ttl_hours" {
  description = "Recorded on the cluster as the `expires` label so a stray lab is findable (and a janitor can delete it). Terraform does not delete anything by itself: `terraform destroy` does."
  type        = number
  default     = 12
}
