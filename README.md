# My Grades

Your own grade page, running on Cloudflare's free plan. Click **Pull from Skyward**,
sign in with your ClassLink login, and it reads your Skyward grades and shows them
with what-if scores and a **what do I need?** calculator.

**Nothing is stored on Cloudflare.** Your ClassLink login is sent to your Worker only
for the pull you start, and your grades are saved in your own browser. You can tick
**Remember my login on this device** to skip typing it next time. That saves it
unencrypted in that browser, so only use it on a device that's yours.

## Deploy it (once, about 5 minutes, all in your browser)

1. Sign in to the Cloudflare dashboard (dash.cloudflare.com).
2. Go to **Workers & Pages** > **Create** > **Import a repository**.
3. Connect GitHub if asked and allow Cloudflare to see the **my-grades** repository.
   Then pick **my-grades**.
4. Keep the project name **my-grades** (it must match `wrangler.jsonc`), and set:
   - Build command: `npm install`
   - Deploy command: `npx wrangler deploy`
5. Click **Deploy** and wait a minute or two.

Your page's address is shown when it's done, something like
`https://my-grades.YOUR-NAME.workers.dev`. Bookmark it.

There are no secrets, variables or storage to set up.

## Using it

1. Open your page and click **Pull from Skyward**.
2. Enter your ClassLink address (e.g. `https://launchpad.classlink.com/yourdistrict`),
   username and password.
   - **More options**: if it gets stuck on the Skyward home page, paste the address of
     your Grading tab (copy it from your browser's address bar while you're on it).
     You can also pick a term like `Q2`.
3. Wait about a minute. Your classes appear on the left.

Your grades stay in that browser. To use another device, use **Backup & data** >
**Export backup** and **Import backup**, or just pull again there.

## If a pull fails

Open **Update from Skyward** on the left. It says which step failed and shows a
screenshot of what the browser saw.

- **"Still on the login page"**: check your username and password.
- **"Couldn't find the ClassLink login form"**: check the ClassLink address. It should
  be the page where you choose **Network Login**.
- **"its layout isn't the classic Skyward Gradebook"**: your district's grades page looks
  different from what this reads. Use **Download a copy of that page**, remove your name,
  and share it so the reader can be adapted.
- **"free browser time for today is used up"**: the free plan allows 10 minutes of
  browser time a day, and each pull uses about 1 to 2. It resets at 6 PM Central.
- ClassLink may treat sign-ins from Cloudflare's servers differently from your home
  connection. If the screenshot shows an extra check or a block, it may not work from
  the cloud.

## Good to know

- Anyone who finds your page's address can open the page, but they'd see an empty grade
  page: your grades are only in your browser. They can't pull anything without a
  ClassLink login.
- To protect your free browser time, the Worker only signs in to `classlink.com`
  addresses, only follows the Skyward site ClassLink opens, and only accepts requests
  from its own page.
- Edit files here on GitHub and Cloudflare redeploys automatically.
- To shut it down, delete the **my-grades** Worker in Cloudflare.

## Files

- `public/index.html`: the grade page
- `src/index.js`: the Worker (serves the page, handles **Pull from Skyward**)
- `src/pull.js`: signs in to ClassLink, opens Skyward's grades, and reads them
- `wrangler.jsonc`: Cloudflare settings
