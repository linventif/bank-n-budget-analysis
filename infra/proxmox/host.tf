# Host-level resources. The bridge, its NAT and the storage are shared between projects and owned by
# another state: they are only referenced by name here (var.bridge, var.datastore_id).

resource "proxmox_virtual_environment_pool" "app" {
  count   = var.create_pool ? 1 : 0
  pool_id = coalesce(var.pool_id, var.app_name)
}

locals {
  pool_id = var.create_pool ? proxmox_virtual_environment_pool.app[0].pool_id : var.pool_id
}

resource "proxmox_download_file" "template" {
  count        = var.template_file_id == null ? 1 : 0
  node_name    = var.node_name
  datastore_id = var.datastore_id
  content_type = "vztmpl"
  url          = var.template_url
  # Never delete a template file this config did not download: set var.template_file_id to use it instead.
  overwrite_unmanaged = false
}
