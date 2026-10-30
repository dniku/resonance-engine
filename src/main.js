// Entry point. Its only job is to be the specifier the bundler starts from:
// `app.js` boots itself, so importing it is the whole of the application.
// Keeping this separate means the page has one script to load whether that is
// `<script type="module" src="src/main.js">` during development or one inlined
// IIFE in the generated single file.
import './app.js';
