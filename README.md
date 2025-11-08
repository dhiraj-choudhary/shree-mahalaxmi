Mahalaxmi Hardware Stores - Product Inquiry Site

This is a small demo site styled for Mahalaxmi Hardware Stores. It lists hardware products and allows customers to place inquiries which are appended to `server/data/inquiries.json`.

Quick start

1. Install dependencies:

```bash
npm install
```

2. Start the server:

```bash
npm start
```

3. Open http://localhost:3000 in your browser.

Notes

- The inquiry form now collects name, phone, email and message. Phone is required.
- This is a demo using a file-backed store for inquiries. For production, use a DB.

Vercel deployment

This project can be deployed to Vercel. A small `vercel.json` and serverless API endpoints are included under `api/` so API routes work as serverless functions.

Important: Vercel functions have ephemeral filesystem storage — writing to `server/data/inquiries.json` will only persist for the lifetime of the function instance. For production you'll want to use a persistent store (e.g., MongoDB, Postgres, or an external file store).

Quick deploy steps

1. Install the Vercel CLI (optional) and login:

```bash
npm i -g vercel
vercel login
```

2. From project root, deploy:

```bash
vercel --prod
```

3. Once deployed, the frontend will be served and the APIs will be available at `/api/products` and `/api/inquiries`.

Local testing of serverless APIs

You can run the static server and test APIs locally by starting the existing Express server (which still works locally):

```bash
npm install
npm start
# open http://localhost:3000
```

Or test the serverless functions using `vercel dev`:

```bash
vercel dev
```

Email notifications for inquiries

By default the app saves inquiries to `server/data/inquiries.json`. To enable email notifications (send each new inquiry to `abc@gmail.com`), set SMTP environment variables before starting the server or in Vercel environment variables.

Required environment variables (example using Gmail SMTP):

- SMTP_HOST (e.g. smtp.gmail.com)
- SMTP_PORT (e.g. 587)
- SMTP_USER (your SMTP username/email)
- SMTP_PASS (your SMTP password or app-specific password)
- TO_EMAIL (optional, default: abc@gmail.com)
- FROM_EMAIL (optional)

Example (Linux/macOS):

```bash
export SMTP_HOST=smtp.example.com
export SMTP_PORT=587
export SMTP_USER=you@example.com
export SMTP_PASS=yourpassword
export TO_EMAIL=abc@gmail.com
npm start
```

On Vercel, add these variables in the project Settings -> Environment Variables.
