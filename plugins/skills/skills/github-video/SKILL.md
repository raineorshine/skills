---
name: github-video
description: >
  Embed a video as an inline player in a GitHub issue, pull request or comment. Use when the user
  sends a screen recording or other video and wants it on GitHub, says "attach this video to #123",
  "add the recording to the issue", or "upload the video to GitHub".
---

Embed a video in a GitHub issue, pull request or comment so it plays inline.

GitHub has no API for this. Only a file attached through the web UI gets a
`https://github.com/user-attachments/assets/<id>` URL, and only those URLs render as a video
player. A video committed to a repo, attached to a release or hosted elsewhere renders as a plain
link. So the upload has to run in the user's own logged-in browser, on the user's own computer.

Never move a GitHub session cookie off that computer, and never ask the user for one. It grants
the whole account. Driving the browser that already holds it grants nothing new.

## Where the video is

- **On the user's computer**, in a session running there with Claude in Chrome: skip to
  [Upload](#upload).
- **In a cloud session**, because the user sent it there: stage it, then hand off to a session on
  the computer. Continue with [Stage](#stage).

## Stage

Run this half in the cloud session that holds the video.

1. **Convert it to .mp4.** Artifacts serve `.mp4` and `.webm` but not `.mov`. A remux keeps the
   quality: `ffmpeg -i in.mov -c copy -movflags +faststart out.mp4`. Re-encode with
   `-c:v libx264 -crf 18` only if the remux fails.
2. **Publish it as a private artifact.** Publish a small page that plays it, with the .mp4 as a
   supporting file under `files`, and note the artifact URL and the file's published path. The
   artifact is private to the user, and the session on the computer runs as the same user, so it
   can fetch the file and nobody else can.
3. **Find the computer.** `list_environments` and take the `bridge` environments. If there is
   none, the computer is not connected: say so and stop. If there are several, ask which one.
4. **Start the upload session there.** `create_session` with that `environment_id` and the prompt
   under [Handoff prompt](#handoff-prompt), filled in.
5. **Tell the user to approve it.** A request relayed from another session cannot post to GitHub
   unattended, so the session on the computer stops before the browser upload. The user opens that
   session and tells it to go ahead. Say this in the reply, with the session's title.

### Handoff prompt

Fill in the angle brackets. It must stand alone, since the new session sees nothing else.

```
Embed a video as an inline player in <target: e.g. "the description of cybersemics/em#5947, under ## Current Behavior">, using my logged-in browser on this machine. Load the github-video skill and follow its Upload section.

The video is the file <published path> on the private Claude artifact <artifact URL>. Fetch it with the Artifact tool (action "read", that url, path "<published path>").

Don't post any new comment. Report the attachment URL and whether the inline player rendered.
```

## Upload

Run this half on the user's computer, with Claude in Chrome. Load the `chrome-browser` skill
first.

1. **Get the file.** If it came from an artifact, fetch it with the Artifact tool (`action:
   "read"`, the artifact `url`, `path` set to the published file) and note where it was saved.
2. **Open the target page** in the user's browser: the issue or pull request the video goes on.
3. **Attach the file to the new-comment box** at the bottom of the page, with the browser's file
   upload tool. The page has no file input until the "Add Files" button ("Paste, drop, or click
   to add files") is clicked, and a real click opens the system file picker, which the browser
   tools cannot drive. So run this with `javascript_tool` to catch the input instead:

   ```js
   const orig = HTMLInputElement.prototype.click;
   HTMLInputElement.prototype.click = function () {
     if (this.type !== 'file') return orig.call(this);
     HTMLInputElement.prototype.click = orig;
     this.style.display = 'block';
     if (!this.isConnected) document.body.appendChild(this);
   };
   [...document.querySelectorAll('button')].find(b => b.textContent.includes('Add Files')).click();
   ```

   Then `find` the file input, pass its ref to `file_upload`, and poll the comment textarea's value
   until it holds a `https://github.com/user-attachments/assets/<id>` URL.
4. **Copy the URL and clear the box.** Never submit that comment. It exists only to get the URL.
   Clear it with real keys: click into the box, press cmd+a, then Backspace, and check it shows
   its placeholder. Delete in place of Backspace left the URL in the box.
5. **Put the URL where the user asked**, on its own line with a blank line before and after, with
   `gh`, and change nothing else in the text:
   - The description of an issue: `gh issue view <n> --repo <owner/repo> --json body`, edit, then
     `gh issue edit <n> --repo <owner/repo> --body-file <file>`. For a pull request, the same with
     `gh pr`.
   - An existing comment: read it with `gh api repos/<owner/repo>/issues/comments/<id>`, then
     `gh api --method PATCH repos/<owner/repo>/issues/comments/<id> -F body=@<file>`.
   - Diff the edited file against the fetched one before saving it back, so the URL line is
     provably the only change.
   - Where the user named no place, follow the repo's issue conventions if it has them (a bug
     report's recording usually goes under Current Behavior), otherwise append it at the end.
6. **Check it renders.** Reload the page and confirm an inline video player shows where the URL
   went. A bare link means the URL was not a `user-attachments` one, or it shares a line with
   other text.
   If another extension blocks screenshots and scripts on the page ("Cannot access a
   chrome-extension:// URL of different extension"), check GitHub's rendering instead:
   `gh api repos/<owner/repo>/issues/<n> -H "Accept: application/vnd.github.html+json" -q
   .body_html` should contain a `<video` element after the target heading. `find` and
   `read_page` still work on such a page, but show the player only as a generic element.
