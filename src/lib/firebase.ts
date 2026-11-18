import { type FirebaseApp, initializeApp } from 'firebase/app';
import { ReCaptchaEnterpriseProvider, initializeAppCheck } from 'firebase/app-check';
import { type AI, GoogleAIBackend, getAI } from 'firebase/ai';
import { fetchAndActivate, getRemoteConfig, getValue } from 'firebase/remote-config';
import { GLOSSARY, type Term } from './glossary';

const env = import.meta.env;

const firebaseConfig = {
  apiKey: env.VITE_FB_API_KEY,
  authDomain: env.VITE_FB_AUTH_DOMAIN,
  projectId: env.VITE_FB_PROJECT_ID,
  storageBucket: env.VITE_FB_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FB_SENDER_ID,
  appId: env.VITE_FB_APP_ID,
};

let app: FirebaseApp | null = null;
let aiInstance: AI | null = null;

// Cloud models change often (and get busy). Remote Config can switch them
// without a new release; these are the built-in defaults.
export type Settings = { cloudModel: string; fallbackModel: string; glossary: Term[] };
let current: Settings = { cloudModel: 'gemini-3.1-flash-lite', fallbackModel: 'gemini-3.5-flash-lite', glossary: GLOSSARY };

export const settings = (): Settings => current;

export const startFirebase = async (): Promise<void> => {
  if (app) return;
  app = initializeApp(firebaseConfig);
  // App Check keeps the AI endpoints for this app only. Local development uses
  // a debug token; the deployed site uses reCAPTCHA (Fraud Defense).
  if (env.DEV || !env.VITE_RECAPTCHA_KEY) {
    (self as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
      env.VITE_APPCHECK_DEBUG_TOKEN || true;
  }
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(env.VITE_RECAPTCHA_KEY || 'debug'),
    isTokenAutoRefreshEnabled: true,
  });
  aiInstance = getAI(app, { backend: new GoogleAIBackend() });

  // Remote Config holds the curated glossary and the cloud model name, so the
  // explanations can be corrected without shipping a new version.
  try {
    const rc = getRemoteConfig(app);
    rc.settings.minimumFetchIntervalMillis = 60 * 60 * 1000;
    rc.defaultConfig = {
      cloud_model: current.cloudModel,
      cloud_fallback_model: current.fallbackModel,
      glossary: JSON.stringify(GLOSSARY),
    };
    await fetchAndActivate(rc);
    const glossary = JSON.parse(getValue(rc, 'glossary').asString()) as Term[];
    current = {
      cloudModel: getValue(rc, 'cloud_model').asString() || current.cloudModel,
      fallbackModel: getValue(rc, 'cloud_fallback_model').asString() || current.fallbackModel,
      glossary: Array.isArray(glossary) && glossary.length ? glossary : GLOSSARY,
    };
  } catch {
    // offline: keep the built-in glossary
  }
};

export const ai = (): AI => {
  if (!aiInstance) throw new Error('Firebase is not started');
  return aiInstance;
};
