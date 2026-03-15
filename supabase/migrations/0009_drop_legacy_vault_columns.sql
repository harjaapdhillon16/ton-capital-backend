alter table if exists users
  drop column if exists vault_address;

alter table if exists deposits
  drop column if exists vault_address;
