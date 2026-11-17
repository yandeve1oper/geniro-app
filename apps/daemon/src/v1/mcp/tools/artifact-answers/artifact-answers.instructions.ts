/** What a model reads about `artifact_answers`. */
export function artifactAnswersInstructions(): string {
  return (
    'Read what the user picked on the pages you published with show_artifact — the choices, ticks ' +
    'and text they entered there, which the app keeps as they pick. ' +
    'Use it when a page asked the user to choose, rate, approve or fill something in and they say ' +
    'they have, or before you act on a decision they made on a page: read it here rather than ask ' +
    'them to copy it into the chat. ' +
    'A page saves answers only from controls marked data-geniro-answer="<name>" or through ' +
    'geniro.saveAnswer(name, value); show_artifact says how to build one. ' +
    'Pass artifact_id for one page, or nothing for every page of this run that has answers. ' +
    'The result is each page’s answers as JSON, with when they were last saved.'
  );
}
