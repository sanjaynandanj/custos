# Gen AI Academy Ideathon submission

Deadline: **6 September 2026, 11:59 PM IST**.

## Submission fields

- **Project:** Custos — Agent Authorization Playground
- **Repository:** https://github.com/sanjaynandanj/custos
- **Live Cloud Run URL:** `MISSING — deploy apps/ideathon and paste the final run.app URL`
- **Social demo URL:** `MISSING — post the X demo and paste its URL`
- **Required hashtag:** `#AccelerateAIwithCloudRun`

## What the demo proves

1. User authenticates with a verified Google account.
2. Gemini on Vertex AI turns natural language into a constrained tool call.
3. Custos enforces deny-by-default policy before execution.
4. The app shows the allow/deny rule and cryptographically signed audit receipt.
5. The full application runs as one container on Cloud Run.

## X post draft

AI agents should not get unlimited authority just because they can call tools.

I built the Custos Agent Authorization Playground: sign in, describe an action, let Gemini plan the tool call, and see Custos allow or block it *before execution*—with an Ed25519-signed, hash-chained audit receipt.

Built with Gemini, Vertex AI and Cloud Run.

Live demo: [CLOUD_RUN_URL]
Code: https://github.com/sanjaynandanj/custos

#AccelerateAIwithCloudRun #GenAI #AIAgents #GoogleCloud #OpenSource

## 45–60 second demo recording

1. **0–5s:** “AI agents can call powerful tools. Custos controls what they are allowed to do.”
2. **5–12s:** Show the live `run.app` URL and Google sign-in.
3. **12–22s:** Run “Read customer cust_1024”; show ALLOWED and the verified receipt.
4. **22–35s:** Run “Refund $250 for payment pay_381”; show BLOCKED by the $100 limit.
5. **35–45s:** Run the shell attack example; show it blocked before execution.
6. **45–55s:** Scroll to the record hash/signature, then show the GitHub repository.
7. **55–60s:** “Deny by default. Allow explicitly. Verify everything.”

## Missing before submission

- [ ] Commit and push `apps/ideathon` and this submission file.
- [ ] Confirm a Google Cloud project with billing and Vertex AI access.
- [ ] Create/configure a Google OAuth Web client for the Cloud Run origin.
- [ ] Grant the Cloud Build service account permission to deploy Cloud Run and act as the runtime service account.
- [ ] Build and deploy the container to Cloud Run.
- [ ] Confirm unauthenticated visitors see sign-in but cannot call `/api/evaluate`.
- [ ] Confirm one allowed and two denied example actions.
- [ ] Record a 45–60 second public demo video.
- [ ] Post it publicly on X with the exact required hashtag.
- [ ] Paste both final URLs into this file and the submission form.
- [ ] Submit before the deadline and save a confirmation screenshot.
