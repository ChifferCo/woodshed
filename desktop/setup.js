// The setup page: the console's address, checked and saved by the app (main.mjs, console:connect).
const params = new URLSearchParams(location.search);
const input = document.getElementById('url');
const button = document.getElementById('go');
const error = document.getElementById('error');
input.value = params.get('current') || '';
error.textContent = params.get('error') || '';

document.getElementById('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  button.disabled = true;
  button.textContent = 'Opening…';
  const answer = await window.woodshedDesktop.connect(input.value).catch((err) => ({ error: err.message }));
  if (answer?.error) {
    error.textContent = answer.error;
    button.disabled = false;
    button.textContent = 'Open the console';
  }
});
