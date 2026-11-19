// Where GitHub and Slack post on AWS: the webhooks Lambda's function URL, at its /github path, and its /slack path for
// Slack's events (webhooks/index.mjs).

/**
 * @param {{functionName: string, aws: (args: string[]) => Promise<any>, path?: '/github'|'/slack'}} opts
 * @returns {() => Promise<string|null>}
 */
export function createWebhookUrl({ functionName, aws, path = '/github' }) {
  // The URL only changes when Terraform replaces the function URL, and every console deploy restarts the
  // console, so it is read once; a failed read is tried again on the next call.
  let read = null;
  return function webhookUrl() {
    read ??= aws(['lambda', 'get-function-url-config', '--function-name', functionName])
      .then((out) => (out?.FunctionUrl ? `${out.FunctionUrl.replace(/\/+$/, '')}${path}` : null))
      .catch((err) => {
        read = null;
        throw err;
      });
    return read;
  };
}
