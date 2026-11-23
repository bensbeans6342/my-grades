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

When nobody is signed in on a device, the page opens on a **home screen** with
**Sign in with ClassLink**, **Look at a sample student** (a made-up student that's never
saved), and **type in grades by hand**. **Sign out** (top right) forgets the login and
erases the grades from that browser. The privacy policy and terms are at `/privacy.html`
and `/terms.html`. The site sets no cookies; everything is in the browser's local storage.


1. Open your page and click **Pull from Skyward**.
2. Enter your ClassLink address (e.g. `https://launchpad.classlink.com/yourdistrict`),
   username and password.
   - **More options**: if it gets stuck on the Skyward home page, paste the address of
     your Grading tab (copy it from your browser's address bar while you're on it).
     You can also pick a term like `NW1` (default: the current, highlighted term).
3. Wait about a minute. Your classes appear on the left.

**Automatic checks**: in **Update from Skyward**, tick **Check for new grades every
15–20 minutes while this page is open** (needs **Remember my login**). Each check signs in
and reads only the grades table (about 30–40 seconds); when something changes it fetches
the assignment details and shows a notification. Checks only run while the page is open in
a browser tab, because your login isn't stored on Cloudflare. They pause before the free
10 minutes a day of browser time runs out, and stop after 3 failed checks in a row.

**GPA calculator** (top of the class list): two GPAs, by semester and overall, using the
district's rules. **Ranking GPA** is weighted (Distinguished 5.0 / Honors 4.5 / Regular 4.0) and
counts only core classes: math, science, history/social studies and English. **Cumulative GPA** is
unweighted (4.0 scale) and counts every class. Each grading period is Major 60% / Daily-Minor 40%;
each semester is Period 1 40% + Period 2 40% + Semester exam 20%. Levels and core classes come from Plano ISD's
Academic Planning Guide (classes of 2030 & 2031); classes not found there are marked **guessed**.
Either can be changed. Type in any grade, like a semester exam score, to see
how it changes both GPAs.

Your grades stay in that browser. To use another device, use **Backup & data** >
**Export backup** and **Import backup**, or just pull again there.

## How pulls work

Pulls sign in with plain web requests, the same ones a browser sends: ClassLink → your district's
sign-in (Network Login) → Skyward → Student Grades. A pull takes a few seconds. If a step fails,
the pull stops and the page shows the error and how far it got. There's no browser fallback.

**Troubleshooting → Capture sign-in** records one sign-in with a browser on Cloudflare (password,
login, cookies and sign-in tokens removed) so a broken sign-in can be fixed. It's the only thing
that uses Cloudflare's browser time (10 free minutes a day).

## If a pull fails

Open **Update from Skyward** on the left. It says which step failed and shows a
screenshot of what the browser saw.

- **"Still on the login page"**: check your username and password.
- **"Couldn't find the ClassLink login form"**: check the ClassLink address. It should
  be the page where you choose **Network Login**.
- **"couldn't find a grades table on it"**: your district's grades page looks different
  from what this reads. Use **Download a copy of that page**, remove names, and share it
  so the reader can be adapted.
- **"couldn't read the assignment details"**: you still get every class's Skyward grades.
  Use **Download the details page**, remove names, and share it so it can be adapted.
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

- `public/index.html`: the grade page (home screen, sample student and the app)
- `public/privacy.html`, `public/terms.html`, `public/legal.css`: privacy policy and terms of service
- `src/index.js`: the Worker (serves the page, handles **Pull from Skyward**)
- `src/direct.js`: the fast sign-in with plain requests (ClassLink, district sign-in, Skyward)
- `src/pull.js`: browser fallback: signs in with a real browser and reads the grades
- `src/qmlativ.js`: reads Skyward's newer **Student Grades** page
- `src/capture.js`: the one-time capture, with secrets removed
- `wrangler.jsonc`: Cloudflare settings
