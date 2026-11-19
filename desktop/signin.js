// The page shown while the browser signs the app in (main.mjs, signInInBrowser), or after a sign-in it could not finish.
const error = new URLSearchParams(location.search).get('error');
if (error) {
  document.getElementById('title').textContent = 'Signing in did not finish';
  document.getElementById('lead').textContent = 'Try again in your browser, or sign in in this window.';
  document.getElementById('error').textContent = error;
}
document.getElementById('browser').addEventListener('click', () => window.woodshedDesktop.signInInBrowser());
document.getElementById('here').addEventListener('click', () => window.woodshedDesktop.signInHere());
