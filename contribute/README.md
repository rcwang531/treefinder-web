# TreeFinder contributions: setup and workflow

The map has two tabs for approved contributors, next to **Sites**:

- **Contribute**
  - **Validate**: click a label polygon and answer *Is this a dead tree?* (Yes / No / Not sure).
  - **Draw**: zoom in to level 16 or closer and **place a site square** by clicking the map anywhere in the contiguous US.
    It is north-aligned and 200, 300 (default) or 500 m on a side. You can also use the square of a selected TreeFinder site.
    Outline the dead trees inside it, then **download** the *site file* and the *annotation file* and/or **submit** them for review.
- **Review**
  - Reviewers open each submission on the map at its NAIP year.
  - They mark every polygon **Correct / Incorrect / Needs edit**, optionally with a comment, and can **add trees that were missed**.
  - They choose **Accept / Needs changes / Reject** with a comment, then submit or download the review.
  - Annotators see their own submissions here with the status, the comments, and the reviewer's marks on the map.

GitHub Pages can't store anything, so this runs on a small **Google Apps Script** web app
(`apps-script/Code.gs`) using a **Google Sheet** and a **shared Google Drive folder**. Everything stays
private to the team. Until it is configured, the site runs in **demo mode**: sign-in is simulated and
everything stays in the browser.

## Files

Every submission has an ID like `CO_001-jdoe-20261023-1530` or `NEW-jdoe-20261023-1530` (site or NEW, contributor, UTC time) and up to three kinds of GeoJSON files.
Each is a FeatureCollection with a top-level `treefinder` block.

| File | `treefinder.kind` | Contents |
|---|---|---|
| `…_site.geojson` | `site` | The square that was annotated: `site_id` (a TreeFinder site, or `NEW` for a placed square), `placed`, `center` (lon, lat), `size_m` and `naip_year` |
| `…_annotation.geojson` | `annotation` | The dead-tree polygons (`id`, `area_m2`, `naip_year`), plus a copy of the square in `site_frame` |
| `…_review_<reviewer>.geojson` | `review` | The annotation's polygons with `review_verdict` and `review_comment`, any trees the reviewer added (`added_by_reviewer: true`), and the reviewer's `decision` and `comment` |

In Drive, the service files them per contributor and submission:

```
<your folder>/contributions/<contributor>/<submission id>/site.geojson
                                                         annotation.geojson
                                                         review_<reviewer>_<UTC time>.geojson
```

**Publishing is manual.** When the team decides accepted work should join the dataset, copy those
folders out of Drive and merge them into the label data. Nothing is published automatically.

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
2. Create a Drive folder, e.g. "TreeFinder contributions", and share it with the team.
   Copy its ID from the folder URL: `drive.google.com/drive/folders/<FOLDER_ID>`.
3. In the Sheet, open **Extensions → Apps Script**, replace the editor contents with `apps-script/Code.gs` and save.
4. **Project Settings → Script properties**, add:
   - `CLIENT_ID` = the client ID from step 1
   - `FOLDER_ID` = the Drive folder ID
5. In the editor, choose the function **`setup`** and click **Run**. Approve the permissions it asks for (Sheets, Drive, external requests).
   This creates the tabs `Contributors`, `Requests`, `Validations`, `Submissions` and `Reviews`.
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

## Approving contributors and reviewers

When someone signs in who isn't on the list, their email is added to the **Requests** tab. To approve them, add a row to **Contributors**:

| email | name | roles | active |
|---|---|---|---|
| jane@umd.edu | Jane Doe | validate, annotate | TRUE |
| lee@umd.edu | Lee Chen | review | TRUE |

The roles are:

- `validate` lets someone answer the polygon question.
- `annotate` lets them draw and submit.
- `review` lets them see and review every submission.

Set `active` to `FALSE` to pause an account. Changes take effect at the contributor's next sign-in.

## Where things are recorded

- **Validations**: one row per answer (time, email, site, polygon ID such as `CO_001-007`, answer, NAIP year, composite).
- **Submissions**: one row per submission. It records the contributor, the site (or `NEW`), whether the square was placed, the polygon count, the status (`pending`, `accepted`, `needs_changes` or `rejected`) and the Drive folder.
- **Reviews**: one row per review (reviewer, decision, comment, file), together with the review file in the submission's folder.

Limits: 2 MB per file and 2,000 polygons per submission, polygons only, and polygons must lie inside the square.
The site checks these, and the script checks them again.

## Updating the script

After editing `Code.gs`, choose **Deploy → Manage deployments → Edit → Version: New version**. This keeps the same URL.
