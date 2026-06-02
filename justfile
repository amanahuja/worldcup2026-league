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

