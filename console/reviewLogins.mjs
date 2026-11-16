// Whose comments and reviews a review session's gates trust, when the project file does not name them: a review run as
// a session (pullRequests.review.runner: woodshed) is posted by this console's own Apps, so the console knows the logins
// and a renamed App needs no change to the file. A login the file names still wins. With no reviewer App no verdict is
// trusted: sessions hold the console App's tokens, so one could submit an approval as it.

/**
 * @param {object|null} gates  the project file's `pullRequests`
 * @param {{reviewerLogin: string|null, ownLogin: string|null}} logins  the reviewer App's and the console App's
 *   `<slug>[bot]`; null for an App the console does not have, or has not read yet
 * @returns {object|null}  the gates, with review.author and review.commentAuthor filled where they were left out
 */
export function withAppLogins(gates, { reviewerLogin, ownLogin }) {
  const review = gates?.review;
  if (!review || review.runner !== 'woodshed') return gates;
  return {
    ...gates,
    review: {
      ...review,
      author: review.author ?? reviewerLogin,
      commentAuthor: review.commentAuthor ?? ownLogin,
    },
  };
}
