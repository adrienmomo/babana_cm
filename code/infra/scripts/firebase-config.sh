#!/bin/sh
# Génère apps/{driver,client}/android/app/google-services.json depuis le projet Firebase
# (15 novembre, notifications push -- code/docs/firebase.md). Jamais versionnés (.gitignore).
#
# Prérequis : gcloud connecté à un compte qui voit le projet (FIREBASE_PROJECT, babana-cm par
# défaut). Sans ces fichiers, les apps se construisent et tournent quand même, sans push.
set -eu

PROJECT="${FIREBASE_PROJECT:-babana-cm}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOKEN="$(gcloud auth print-access-token)"
API="https://firebase.googleapis.com/v1beta1"

apps_json="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" "$API/projects/$PROJECT/androidApps")"

for pair in "cm.babana.driver:driver" "cm.babana.client:client"; do
  package="${pair%%:*}"
  app="${pair#*:}"
  app_id="$(printf '%s' "$apps_json" | python3 -c "import sys,json; print(next(a['appId'] for a in json.load(sys.stdin)['apps'] if a['packageName']=='$package'))")"
  target="$ROOT/apps/$app/android/app/google-services.json"
  curl -fsS -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" "$API/projects/-/androidApps/$app_id/config" \
    | python3 -c "import sys,json,base64; sys.stdout.buffer.write(base64.b64decode(json.load(sys.stdin)['configFileContents']))" > "$target"
  echo "écrit : $target"
done
