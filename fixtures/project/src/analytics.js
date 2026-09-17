/** Fixture analytics sink. Its calls are the "effects" the codemods worry about. */
export const analytics = {
  send(event) {
    return event;
  },
};
