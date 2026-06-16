// Capture Untappd "Show More" (more_feed) response for the check-in sync fix (#145).
//
// HOW TO USE:
// 1. In your browser, LOG IN to Untappd and open your profile:
//       https://untappd.com/user/ysilvestrov
// 2. Open DevTools (F12) -> Console.
// 3. Paste this whole file's contents into the Console and press Enter.
// 4. It downloads "ysilvestrov_more_feed_1577238079.txt" to your browser's Downloads.
//    (The Console also prints the length + first 200 chars so you can confirm it's
//     real data and not a redirect to /home.)
// 5. Get that file onto the server into ./tmp/ the same way you transferred the
//    earlier captures, and tell Claude.
//
// Must run in the untappd.com page context (NOT a file:// page) so it carries your
// login cookies. The X-Requested-With header is what stops Untappd 307-redirecting
// the request to /home (it only serves more_feed to XHR requests).

(async () => {
  const user = 'ysilvestrov';
  const offset = '1577238079'; // oldest check-in id from page 1 (the cursor to page past)
  const url = `/profile/more_feed/${user}/${offset}?v2=true`;
  try {
    const res = await fetch(url, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
    });
    const body = await res.text();
    console.log('status:', res.status, res.redirected ? '(REDIRECTED!)' : '', 'length:', body.length);
    console.log('starts with:', body.slice(0, 200));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    a.download = `${user}_more_feed_${offset}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    console.log('Downloaded', a.download, '— move it into ./tmp/ on the server.');
  } catch (e) {
    console.error('capture failed:', e);
  }
})();
