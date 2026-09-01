# Custos Agent Authorization Playground

Authenticated Cloud Run demo for the Gen AI Academy Ideathon. Gemini converts a user's natural-language intent into a constrained tool call. Custos evaluates it before execution and returns an Ed25519-signed, SHA-256 hash-chained decision receipt.

## Google Cloud setup

1. Select a billed Google Cloud project and enable the required APIs.
2. Create the Artifact Registry repository and a least-privilege runtime service account.
3. Create an OAuth 2.0 Web client. After the first deployment, add the final Cloud Run origin to **Authorized JavaScript origins**.
4. Submit the checked-in Cloud Build pipeline from the repository root.

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com aiplatform.googleapis.com
gcloud artifacts repositories create custos --repository-format=docker --location=asia-south1
gcloud iam service-accounts create custos-ideathon --display-name="Custos Ideathon runtime"
gcloud projects add-iam-policy-binding "$GOOGLE_CLOUD_PROJECT" \
  --member="serviceAccount:custos-ideathon@$GOOGLE_CLOUD_PROJECT.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"

gcloud builds submit \
  --config cloudbuild.ideathon.yaml \
  --substitutions=_GOOGLE_CLIENT_ID=YOUR_CLIENT_ID
```

The account running Cloud Build must be able to build/push images, deploy Cloud Run, and act as the runtime service account. The Cloud Build file caps the demo at one instance to keep its ephemeral signed ledger internally consistent.

The service is publicly reachable, while `/api/evaluate` requires a verified Google ID token. Tool execution is deliberately simulated; the submission demonstrates planning, authorization, and evidence without exposing destructive tools.

## Local verification

```bash
cd apps/ideathon
npm install
npm test
cd ../../packages/custos-js && npm install && npm run build
cd ../../apps/ideathon && npm install --force
GOOGLE_CLIENT_ID=... GOOGLE_CLOUD_PROJECT=... npm start
```
