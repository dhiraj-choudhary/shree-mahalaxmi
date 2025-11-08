document.getElementById('upload-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const status = document.getElementById('status');
  const input = document.getElementById('file');
  if (!input.files || input.files.length === 0) { status.textContent = 'Select a file first.'; return; }
  const file = input.files[0];
  const form = new FormData();
  form.append('file', file, file.name);
  status.textContent = 'Uploading...';
  try {
    const res = await fetch('/api/admin/upload-products', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data && data.error ? data.error : 'Upload failed');
    status.textContent = 'Uploaded successfully.';
  } catch (err) {
    console.error(err);
    status.textContent = 'Upload failed: ' + (err.message || err);
  }
});

