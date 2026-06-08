// Browser voice dictation for the composer. Uses the Web Speech API
// (SpeechRecognition / webkitSpeechRecognition) to transcribe speech into the
// active composer textarea, so people can speak to the agent instead of typing.
// Feature-detected: when the browser has no SpeechRecognition (e.g. Safari /
// iOS), app.js adds body.no-voice and the mic button is hidden via CSS.

import { renderAlert } from './dom.js';

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

export function voiceSupported() {
  return Boolean(SR);
}

let recognition = null;
let activeBtn = null;
let activeTextarea = null;
let baseText = '';

function reset() {
  if (activeBtn) { activeBtn.classList.remove('is-listening'); activeBtn.setAttribute('aria-pressed', 'false'); }
  recognition = null; activeBtn = null; activeTextarea = null;
}

export function toggleComposerDictation(btn) {
  if (!SR) { renderAlert('Voice input isn’t supported in this browser.', 'warn'); return; }
  // Second click on the listening button stops it.
  if (activeBtn === btn && recognition) { try { recognition.stop(); } catch { /* ignore */ } return; }
  const form = btn.closest('form');
  const textarea = form?.querySelector('textarea[name="message"]');
  if (!textarea) return;
  if (recognition) { try { recognition.stop(); } catch { /* ignore */ } }

  recognition = new SR();
  recognition.lang = navigator.language || 'en-US';
  recognition.interimResults = true;
  recognition.continuous = true;
  activeBtn = btn;
  activeTextarea = textarea;
  baseText = textarea.value ? `${textarea.value.replace(/\s*$/, '')} ` : '';
  btn.classList.add('is-listening');
  btn.setAttribute('aria-pressed', 'true');

  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = 0; i < event.results.length; i += 1) transcript += event.results[i][0].transcript;
    if (!activeTextarea) return;
    activeTextarea.value = `${baseText}${transcript}`.trimStart();
    activeTextarea.dispatchEvent(new Event('input', { bubbles: true }));
  };
  recognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      renderAlert('Microphone permission was blocked.', 'warn');
    }
  };
  recognition.onend = reset;

  try {
    recognition.start();
  } catch {
    reset();
  }
}
