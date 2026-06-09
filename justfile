# Justfile for worldcup project

# -- variables -- 

private_configpath := ".agents"

# -- base  -- 

_default: 
  @just --list

# -- recipes -- 


# list users with their passwords
ls: 
  bat {{private_configpath}}/users.txt


# add a user
# usage: adduser foo passphrase
adduser user pass:
  mise exec -- wrangler kv key put --binding WC2026_USERS --remote "{{user}}" "{{pass}}"
  echo "{{user}} / {{pass}}" >> {{private_configpath}}/users.txt

# delete a user
# usage: deleteuser foo
deleteuser user:
  @grep -q "^{{user}} /" {{private_configpath}}/users.txt || (echo "Error: user '{{user}}' not found in users.txt" && exit 1)
  mise exec -- wrangler kv key delete --binding WC2026_USERS --remote "{{user}}"
  sed -i "/^{{user}} \//d" {{private_configpath}}/users.txt

# show prediction counts per user
pcount:
  @for user in $(cat {{private_configpath}}/users.txt | cut -d'/' -f1 | tr -d ' '); do \
    gfile="data/predictions/$user-groups.yaml"; \
    kfile="data/predictions/$user-knockout.yaml"; \
    groups=$([ -f "$gfile" ] && grep -c "predicted_winner" "$gfile"; true); \
    knockout=$([ -f "$kfile" ] && grep -c "predicted_winner" "$kfile"; true); \
    printf "%-30s groups: %-4s knockout: %s\n" "$user" "${groups:-0}" "${knockout:-0}"; \
  done

