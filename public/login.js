(() => {
  const form = document.querySelector('.login-form');
  if (!form) return;

  const password = form.querySelector('input[name="password"]');
  const toggle = form.querySelector('.password-toggle');
  const submit = form.querySelector('.login-submit');
  const fields = form.querySelectorAll('input');

  toggle?.addEventListener('click', () => {
    const visible = password.type === 'text';
    password.type = visible ? 'password' : 'text';
    toggle.textContent = visible ? 'Show' : 'Hide';
    toggle.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
    toggle.setAttribute('aria-pressed', String(!visible));
    password.focus();
  });

  fields.forEach(field => {
    const update = () => field.closest('label')?.classList.toggle('is-filled', Boolean(field.value));
    field.addEventListener('input', update);
    update();
  });

  form.addEventListener('submit', () => {
    submit.disabled = true;
    submit.classList.add('is-loading');
    submit.querySelector('span').textContent = 'Checking access';
  });
})();