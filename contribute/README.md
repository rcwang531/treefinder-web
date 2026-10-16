# TreeFinder contributions: setup

The map's **Contribute** tab lets approved contributors

- **validate** labels: click a polygon and answer *Is this a dead tree?* (Yes / No / Not sure)
- **draw** new labels at a TreeFinder site on its latest NAIP year, **download** them as GeoJSON and **upload** the file.

GitHub Pages can't store anything, so sign-in checks, answers and uploads go to a small
**Google Apps Script** web app (`apps-script/Code.gs`). It keeps answers in a **Google Sheet**
and puts uploaded files in a **shared Google Drive folder**. Until it is configured, the site runs
in **demo mode**: sign-in is simulated and nothing leaves the browser.

## One-time setup (about 20 minutes)

### 1. Google sign-in client ID

1. Open <https://console.cloud.google.com/>, then create a project or pick one (for example "TreeFinder").
2. **APIs & Services → OAuth consent screen**:
   - Choose User type **External** and give the app the name "TreeFinder".
   - Enter your email as the support email and save. The only scopes needed are `openid`, `email` and `profile`.
   - Publish the app (**In production**). This only lets any Google account see the sign-in prompt; the contributor list still controls who can submit.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Choose Application type **Web application**.
   - Under **Authorized JavaScript origins**, add `https://rcwang531.github.io` and `http://localhost:5173`.
   - Copy the **Client ID** (`…apps.googleusercontent.com`).

### 2. Sheet, Drive folder and script

1. Create a Google Sheet, e.g. "TreeFinder contributions".
2. Create a Drive folder for uploads, e.g. "TreeFinder uploads", and share it with the team.
   Copy its ID from the folder URL: `drive.google.com/drive/folders/<FOLDER_ID>`.
3. In the Sheet, open **Extensions → Apps Script**, replace the editor contents with `apps-script/Code.gs` and save.
4. **Project Settings → Script properties**, add:
   - `CLIENT_ID` = the client ID from step 1
   - `FOLDER_ID` = the Drive folder ID
5. In the editor, choose the function **`setup`** and click **Run**. Approve the permissions it asks for (Sheets, Drive, external requests).
   This creates the tabs `Contributors`, `Requests`, `Validations` and `Uploads`.
6. **Deploy → New deployment → Web app**:
   - Set **Execute as** to *Me*.
   - Set **Who has access** to *Anyone*. This only makes the URL reachable; every request still needs a valid Google sign-in for your client ID.
   - Copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`).

### 3. Connect the site

Edit `web/src/contribute/config.ts`:

```ts
export const GOOGLE_CLIENT_ID = "1234567890-abc…apps.googleusercontent.com";
export const APPS_SCRIPT_URL = "https://script.google.com/macros/s/…/exec";
```

Commit and push. The demo banner disappears and the Google sign-in button appears.

## Approving contributors

When someone signs in who isn't on the list, their email is added to the **Requests** tab and the
site tells them their request was recorded. To approve them, add a row to **Contributors**:

| email | name | roles | active |
|---|---|---|---|
| jane@umd.edu | Jane Doe | validate, annotate | TRUE |

`roles` is `validate`, `annotate`, or both. Set `active` to `FALSE` to pause an account. Changes take effect at the contributor's next sign-in.

## What gets stored

- **Validations** gets one row per answer: time, email, site, polygon ID (e.g. `CO_001-007`), answer, NAIP year and composite.
  A contributor's latest answer per polygon is what the map shows them.
- **Uploads** gets one row per file. The file itself goes into the Drive folder as `<site>_<email>_<UTC time>.geojson`.
  Each file is a GeoJSON FeatureCollection of polygons with `site`, `naip_year`, `annotator`,
  `label` and `area_m2` properties, plus a top-level `treefinder` block with the same details.

Limits: 2 MB and 2,000 polygons per file, polygons only, and polygons must lie inside the site.
The site enforces all of these; the script re-checks everything except the inside-the-site rule.

## Updating the script

After editing `Code.gs`, choose **Deploy → Manage deployments → Edit → Version: New version**. This keeps the same URL.
