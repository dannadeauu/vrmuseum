# Virtual Museum (A-Frame, WebXR)

One web page that runs on desktop (mouse + WASD) and on Meta Quest (thumbsticks + laser pointers).

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Controls

| | PC | Quest |
|---|---|---|
| Move | WASD / arrow keys | Left thumbstick |
| Look / turn | Click and drag | Head, plus right thumbstick for 45° snap turns |
| Read about a piece | Click it | Point the laser and pull the trigger |
| Enter VR | — | The "VR" button in the bottom-right corner |

## Admin mode (add images, PDFs and 3D models)

Open **http://localhost:8000/?admin** and click **Admin** in the top-left corner.

1. **Add image, PDF or 3D model…**: choose a PNG/JPG/WebP image, a PDF, or a `.glb` model.
2. **Click a wall** to hang an image or PDF, or **click the floor** to stand it up. Models always go on the floor. Press Esc to cancel.
3. The new item is selected automatically. Edit its title, artist, year, description and size. Floor items also get rotation. Models have a **plinth** option, and standing images and PDFs have a **display stand** option, which is on by default; turned off, the piece rests on small feet. Changes save as you type.
4. Click **any** piece to edit it, **Move** it, or **Delete** it. That includes the starter paintings, the sculpture and the benches.

**Signs:** **Add sign** creates a sign lettered in Playfair Display. Hang it on a wall, or click the floor to stand it on a display stand. In the editor you can change the text (press Enter for more lines), the style (bronze, stone or navy plate, or letters only, dark or light), the size and the position. The "Virtual Museum" plate is a sign too, so it's editable. The font loads from Google Fonts; offline, signs fall back to Georgia.

**Starter exhibits:** the five placeholder paintings, the knot sculpture and the two benches are added automatically the first time a browser opens the museum. After that they're ordinary items, so changes stick. **Restore starter exhibits** brings back any you've deleted, without duplicating the rest. Their defaults are in `STARTERS` in `js/user-exhibits.js`.

Visitors can turn PDF pages with the `<` `>` buttons under each PDF, using the mouse or the VR lasers.

**Important limits for now:**
- **It's local only.** Uploads are saved in this browser (IndexedDB), and other people and devices won't see them. To move a layout, use **Export layout**, which makes one `.json` file with the files inside, then **Import layout** on the other device (for example, in the Quest Browser before entering VR). Importing replaces what's there.
- **`?admin` is not security.** Anyone who adds `?admin` to the URL gets the panel, but they can only change their own browser's copy. Real admin accounts will need a backend, such as Supabase or a small server, when you add multiplayer.
- **Use self-contained `.gltf` files.** A `.gltf` that points to separate `.bin` or texture files won't load. Use `.glb` instead.

## Online museum (Supabase)

With Supabase set up, everyone sees the same museum, and admin changes show up live for every visitor, including people already inside it. Your project's URL and public key are in `js/supabase-config.js`.

**One-time setup** (on supabase.com, in your project):
1. **Authentication → Users → Add user → Create new user.** Enter your email and a password, and tick *Auto Confirm User*. This is your admin login.
2. *(Recommended)* **Authentication → Sign In / Providers:** turn off *Allow new users to sign up*.
3. **SQL Editor → New query:** paste all of `supabase/setup.sql` and click **Run**.
4. Open the museum with `?admin`, click **Admin** and log in. That's it: there's no publishing. Everything you add, move, edit or delete saves automatically and appears for every visitor right away ("Saved: live for everyone").

**After that:**
- Visitors don't need `?admin` or an account. They see the shared museum, and changes appear live.
- **Backups:** **Export layout** downloads the whole museum (exhibits plus uploaded files) as one file, and **Import layout** restores it. Importing always downloads a backup of the current museum first.
- If the online museum can't be reached, editing pauses (nothing is saved only in one browser).
- To add another admin, create the user (step 1), then run `supabase/setup.sql` again.
- If Supabase can't be reached, the museum falls back to the copy saved in the visitor's browser (or the starter exhibits), so it never shows an empty room.
- Never put the **service_role / secret key** or your database password in these files.

## Files

- `index.html`: the rotunda layout, lighting and player rig (exhibits are saved items, not hard-coded)
- `js/rooms.js`: the four barrel-vaulted galleries (slate-blue walls, arched clerestory windows, a half-moon window at the far end) and the rotunda's arched wall. Their window, lamp and sun light is baked like the rotunda's. Change which bays get arches in `index.html` (`rotunda-walls="arches: 90, 150, 210, 270"` plus a matching `gallery-room` for each).
- `js/architecture.js`: code-drawn textures for the walls, dome, oculus, pine floor and cornice, plus the instanced pilasters. Daylight is baked into these textures, so the room needs no real-time lights.
- `js/components.js`: custom components (`thumbstick-locomotion`, `bounds`, `jump`, `exhibit`, `placeholder-art`, `slow-spin`)
- `js/store.js`: where exhibits are saved. That's Supabase when it's set up (`js/supabase-config.js`, `supabase/setup.sql`), otherwise this browser (IndexedDB).
- `js/user-exhibits.js`: builds uploaded items in the scene, including the PDF viewer and model auto-sizing
- `js/admin.js` + `css/admin.css`: the admin panel and click-to-place

## Adding real artwork

1. Put the image in `assets/`, then add it to `<a-assets>`: `<img id="art-foo" src="assets/foo.jpg">`
2. On the exhibit, replace `placeholder-art="seed: N"` with `material="src: #art-foo; shader: flat"`
3. Set `width` and `height` to match the image's aspect ratio

For 3D pieces, use `<a-asset-item id="bust" src="assets/bust.glb">` and add an entity with `gltf-model="#bust"`.

## Keeping it fast on Quest

- Images should be ≤2048px on the long edge, and JPG/WebP rather than PNG.
- Compress GLB files: `npx @gltf-transform/cli optimize in.glb out.glb --compress draco --texture-compress webp`
- Bake lighting into textures and skip real-time shadows. Keep to 1 ambient light and 1–2 directional lights.
- Use `shader: flat` for paintings, since they don't need lighting.
- To see the FPS counter, add `stats` to `<a-scene>`. Aim for a steady 72–90 fps on the headset.
- If the gallery grows large, split it into rooms and load each one on demand.

## Testing on a Quest

WebXR needs HTTPS (localhost is the only exception), so pick one of these:
- **Deploy it.** GitHub Pages, Netlify or Cloudflare Pages all serve static files over HTTPS for free. Open the URL in the Quest Browser.
- **Use a USB cable.** Run `adb reverse tcp:8000 tcp:8000`, then open `http://localhost:8000` in the Quest Browser.
- **Use a tunnel.** `cloudflared tunnel --url http://localhost:8000` gives you a temporary HTTPS URL.

To test VR without a headset on desktop, install the **Immersive Web Emulator** Chrome extension (by Meta).
