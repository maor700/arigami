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

variable "extra_node_pools" {
  description = <<-EOT
    Additional node pools, e.g. a bigger machine for one person's tenant (control-plane tier with a matching nodeSelector,
    docs/CONTROL-PLANE.md "Tiers"). Map of pool name => settings. Empty (the default) creates nothing, so existing plans do not change.
    Every pool gets the label pool=<name>; `labels` adds more. `taints` keep other tenants off it (effect: NO_SCHEDULE, PREFER_NO_SCHEDULE or NO_EXECUTE) —
    pair them with `tolerations` in the tier.
  EOT
  type = map(object({
    machine_type = string
    node_count   = optional(number, 1)
    disk_gb      = optional(number, 100)
    labels       = optional(map(string), {})
    taints = optional(list(object({
      key    = string
      value  = string
      effect = string
    })), [])
  }))
  default = {}

  validation {
    condition     = alltrue([for n, p in var.extra_node_pools : can(regex("^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$", n)) && n != "main"])
    error_message = "extra_node_pools keys must be valid node pool names (lowercase letters, digits, '-'; at most 40 characters) and not \"main\"."
  }
  validation {
    condition     = alltrue([for n, p in var.extra_node_pools : alltrue([for t in p.taints : contains(["NO_SCHEDULE", "PREFER_NO_SCHEDULE", "NO_EXECUTE"], t.effect)])])
    error_message = "A taint effect must be NO_SCHEDULE, PREFER_NO_SCHEDULE or NO_EXECUTE."
  }
}
