async (page) => {
  // Faked for the check: the dev console has no sign-in and no GitHub. Mine as octocat, and his pull requests.
  const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString();
  const checks = (pass, fail, pending) => ({ pass, fail, pending, total: pass + fail + pending });
  const pulls = [
    { number: 26974, title: 'docs(woodshed): tell sessions how to prove a fix', branch: 'woodshed/fedd1111', why: 'yours', updatedAt: ago(1), draft: false, checks: checks(9, 0, 0), project: 'example-repo', repo: 'example-org/example-repo' },
    { number: 412, title: 'fix(auth): keep the API key out of the request log', branch: 'woodshed/fede2222', why: 'yours', updatedAt: ago(5), draft: false, checks: checks(5, 1, 0), project: 'example-api', repo: 'example-org/example-api' },
    { number: 26970, title: "ci(woodshed): build each pull request's session image", branch: 'ci/session-image', why: 'yours', updatedAt: ago(24), draft: false, checks: checks(9, 0, 0), project: 'example-repo', repo: 'example-org/example-repo' },
    { number: 88, title: 'feat(pricing): show the plan picker on the pricing page', branch: 'feat/plan-picker', why: 'yours', updatedAt: ago(30), draft: false, checks: checks(3, 0, 0), project: 'example-web', repo: 'example-org/example-web' },
    { number: 1192, title: 'fix(checkout): round tax per line, not per order', branch: 'fix/tax', why: 'review', updatedAt: ago(3), draft: false, checks: checks(4, 0, 3), project: 'example-api', repo: 'example-org/example-api' },
    { number: 85, title: 'chore: build with the new bundler', branch: 'chore/bundler', why: 'review', updatedAt: ago(120), draft: true, checks: null, project: 'example-web', repo: 'example-org/example-web' },
  ];
  await page.route('**/api/my/pulls', (route) => route.fulfill({ json: { pulls } }));
  await page.route('**/api/sessions', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const base = body.sessions.find((x) => x.id === 'dddd4444');
    const live = { ...base, id: 'fedd1111', title: 'Prove a fix in the docs', kind: 'task', number: null, owner: 'octocat', branch: 'woodshed/fedd1111', state: 'working' };
    const stopped = { ...body.sessions.find((x) => x.id === 'aaaa1111'), id: 'fede2222', title: 'Keep the API key out of the logs', kind: 'task', number: null, owner: 'octocat', branch: 'woodshed/fede2222', project: 'example-api', repo: 'example-org/example-api' };
    await route.fulfill({ response: res, json: { ...body, login: 'octocat', sessions: [live, stopped, ...body.sessions] } });
  });
  await page.goto('http://localhost:7690/');
  await page.evaluate(() => { localStorage.setItem('woodshed-cloud-rail-zones', '{"ended":false,"stopped":false,"merged":false}'); localStorage.removeItem('woodshed-cloud-rail-project'); });
  await page.goto('http://localhost:7690/s/aaaa1111');
  await page.waitForSelector('.is-pulls-zone .prow');
  const zone = page.locator('.is-pulls-zone');
  await zone.scrollIntoViewIfNeeded();
  return await zone.evaluate((z) => z.innerText);
}
