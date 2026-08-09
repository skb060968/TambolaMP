import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);

/** Resolves only after Firebase has a real authenticated user. */
export const authReady = new Promise((resolve, reject) => {
  let settled = false;
  const finish = (fn, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    unsubscribe();
    fn(value);
  };
  const timeoutId = setTimeout(
    () => finish(reject, new Error('Authentication timed out. Check your connection and try again.')),
    15000,
  );
  const unsubscribe = onAuthStateChanged(
    auth,
    (user) => {
      if (user?.uid) finish(resolve, user);
    },
    (error) => finish(reject, error),
  );
  if (!auth.currentUser) {
    signInAnonymously(auth).catch((error) => finish(reject, error));
  }
});

authReady.catch((error) => console.error('Firebase authentication failed:', error));
