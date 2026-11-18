# Fumi 文: understand Japanese letters, privately

**Try it:** https://fumi-letters.web.app (Chrome on a desktop with a GPU gives you the full on-device experience; any browser works with the cloud path)

**Demo video (2 min):** https://youtu.be/A2WVpm70f-E

**Fumi** helps people who live in Japan but don't read Japanese understand the official letters that land in their mailbox: resident tax bills, health insurance and pension notices, reminders from the city office. Take a photo, and Fumi tells you what the letter is, what you have to do, by when and how much, in your language.

Those letters carry the most sensitive data a resident has: name, address, **My Number** (the national ID number), insurance and pension numbers. So Fumi is built around one rule:

> **The photo and the full text of a letter never leave your device.** Reading the photo and covering personal details happen on-device with Gemini Nano. The cloud is used only for what the device can't do, only ever sees text with the personal details already covered, and the reader sees exactly what would be sent before it is sent.

Japan has 4,281,026 foreign residents ([Immigration Services Agency, end of June 2026](https://www.moj.go.jp/isa/publications/press/13_00047.html)), a record high. Missing a deadline in one of these letters means late fees, lost insurance cover or seized assets. Today many people paste photos of them into chat apps and translation services, personal details and all.

## How it uses Firebase AI Logic hybrid inference

Fumi doesn't just "prefer on-device and fall back to the cloud". It **routes each step by how sensitive its input is**:

| Step | Input | Where it runs | Firebase AI Logic |
|---|---|---|---|
| 1. Read the letter | the photo (raw, personal) | **on-device only**, top and bottom half separately for small text | `ONLY_ON_DEVICE`, image + text in, plain text out |
| 2. Find personal details | the raw transcript | **on-device only**, then fixed patterns double-check | `ONLY_ON_DEVICE` with a JSON `responseConstraint` |
| 3. Explain | the **covered** transcript | on-device when Gemini Nano writes the reader's language (English, Spanish, Japanese), otherwise the cloud, after the reader confirms | `PREFER_ON_DEVICE` / `ONLY_IN_CLOUD` with a `responseSchema` |
| 4. Follow-up questions | covered transcript + covered question | on-device when possible; the cloud on request | `ONLY_ON_DEVICE` / `ONLY_IN_CLOUD` |

Measured on a laptop with an RTX 2060 (Chrome 157): reading 10–19 s, finding personal details 4–6 s, explaining on the device 16–19 s or in the cloud 3–7 s.

### Privacy by construction

- **Numbered labels instead of personal data.** Each personal item becomes a label like `[NAME 1]` or `[PHONE 1]` before anything else happens (`src/lib/redact.ts`). The labels and the real values stay in the tab. When an explanation needs one of them, like the office phone number to call, the app fills the real value back in **on the screen only** and marks it.
- **Two independent layers find personal data:** Gemini Nano lists what it sees, and deterministic patterns catch My Number, phone and postal formats, account and ID numbers after any 番号 label, names before 様/殿 and addresses. Nothing goes to the cloud unless the text passes a last pattern check (`looksClean`).
- **The reader sees it first.** Before covered text leaves the device, Fumi shows exactly what would be sent, with the option to keep everything on the device and get the explanation in English instead.
- **No local model?** Fumi never silently sends the photo. The reader draws black boxes over their details (the *cover tool*), confirms, and only the covered copy is read in the cloud. The same tool is offered if the on-device model can't read a photo.
- **Every answer is labelled** with where it was produced (`inferenceSource`): *On device* or *Cloud*, and the privacy panel shows what was sent, if anything, and how long each step took.

### Built for small models

- **Facts are checked by code, not trusted.** The deadline and amount printed next to their labels (納期限, 納付額) win over the model's answer; Japanese era dates (令和8年12月28日) become calendar dates in code; the sender must appear in the letter. Anything that can't be matched is flagged "double-check".
- **Language check.** If a model answers in English when Nepali was asked for, Fumi notices (by script) and tries the next model.
- **Plain text where it helps.** Reading a photo as plain text is several times faster and more complete on Gemini Nano than asking for JSON, so reading and finding personal data are two separate on-device calls.
- **Warm start.** The on-device model is loaded when the page opens, so the first letter doesn't wait for it.

### Firebase services

- **Firebase AI Logic** (Gemini Developer API) for all inference, on-device (Gemini Nano in Chrome) and in the cloud.
- **App Check** with reCAPTCHA Enterprise protects the Gemini endpoints (enforced). Local development uses a debug token.
- **Remote Config** holds the cloud model name, a fallback model (used when the first is busy or slow), and the curated glossary of official terms (住民税, 国民健康保険, 督促状, …) that grounds every explanation, on-device and in the cloud. Models and wording can change without a new release.
- **Hosting** for the web app.

## Features

- Photo → what it is, what to do, deadline (with a countdown), amount, how to pay, who to call, in 10 languages (English, Chinese, Vietnamese, Korean, Tagalog, Portuguese, Nepali, Indonesian, Spanish, Burmese)
- One-tap calendar reminder (.ics, made in the browser, alert 3 days before)
- Checklist of actions and a glossary of the official terms in the letter
- Follow-up questions ("Can I pay this at a convenience store?")
- Three fictional sample letters (marked 見本) to try without a real letter
- The on-device steps need no connection once the page is open; a one-click model download if Chrome hasn't fetched it yet

## Run it

Requirements: Node 20+, a Firebase project with **AI Logic (Gemini Developer API)**, **App Check** and **Remote Config**, and for the on-device path Chrome on a desktop with a supported GPU (the app checks with `LanguageModel.availability()`).

```bash
npm install
cp .env.example .env    # your Firebase web config and reCAPTCHA Enterprise site key
npm run dev             # http://localhost:5173
npm test                # unit tests (redaction, fact checks, dates, calendar file)
npm run build && npx firebase deploy --only hosting
```

For local development App Check uses a debug token: put it in `.env.development.local` as `VITE_APPCHECK_DEBUG_TOKEN` (it is never part of a production build) and register the same token in the Firebase console (App Check → Apps → Manage debug tokens).

Remote Config parameters (all optional; the app has built-in defaults): `cloud_model` (default `gemini-3.1-flash-lite`), `cloud_fallback_model` (default `gemini-3.5-flash-lite`), `glossary` (JSON array of `{ "ja", "en" }`).

## Code map

- `src/lib/ai.ts`: every model call and the routing rule (`transcribeOnDevice`, `findPersonalOnDevice`, `readCoveredInCloud`, `explain`, `ask`), the model fallback, the language check and the fact checks
- `src/lib/redact.ts`: numbered labels, the pattern safety net, `looksClean`, and putting values back for the screen
- `src/lib/image.ts`: splitting a page into halves along an empty line, and joining the two transcripts
- `src/lib/wareki.ts`: Japanese era dates
- `src/lib/firebase.ts`: Firebase, App Check and Remote Config
- `src/components/CoverTool.tsx`: covering by hand when there is no local model
- `src/components/Chat.tsx`: follow-up questions

## Privacy

Fumi has no backend of its own and stores nothing on a server. Letters, transcripts and results stay in the browser tab; only the language choice is saved, in local storage. What can reach the cloud model (Gemini via Firebase AI Logic) is covered text the reader has seen, or a photo the reader covered by hand.

The sample letters and all names, addresses and numbers in them are fictional.

## License

Apache License 2.0, see [LICENSE](LICENSE).
