import {
  commands,
  DecorationRenderOptions,
  Disposable,
  Position,
  Range,
  Selection,
  TextDocument,
  TextDocumentChangeEvent,
  TextEditor,
  TextEditorDecorationType,
  Uri,
  window,
} from "vscode";
import { BetterFoldingRange, BetterFoldingRangeProvider } from "./types";
import ExtendedMap from "./utils/classes/extendedMap";
import { foldingRangeToRange, groupArrayToMap, rangeToInlineRange } from "./utils/utils";
import * as config from "./configuration";
import { BookmarksManager } from "./bookmarksManager";

const DEFAULT_COLLAPSED_TEXT = "…";

export default class FoldingDecorator extends Disposable {
  timeout: NodeJS.Timer | undefined = undefined;
  providers: Record<string, BetterFoldingRangeProvider[]> = {};
  unfoldedDecoration = window.createTextEditorDecorationType({});
  zenModeDecoration: TextEditorDecorationType;
  bookmarksManager = new BookmarksManager();

  decorations: ExtendedMap<Uri, TextEditorDecorationType[]> = new ExtendedMap(() => []);
  cachedFoldedLines: ExtendedMap<Uri, number[]> = new ExtendedMap(() => []);

  constructor(universalProviders: BetterFoldingRangeProvider[]) {
    super(() => this.dispose());
    this.providers["*"] = [...universalProviders];
    this.zenModeDecoration = window.createTextEditorDecorationType(this.newDecorationOption(DEFAULT_COLLAPSED_TEXT));
  }

  public registerFoldingRangeProvider(selector: string, provider: BetterFoldingRangeProvider) {
    if (!this.providers[selector]) {
      this.providers[selector] = [];
    }

    this.providers[selector].push(provider);
  }

  //TODO: move all zen related things to a separate class.
  public onChange(change: TextDocumentChangeEvent) {
    this.bookmarksManager.onChange(change);
  }

  public async enableZenFolding() {
    const editor = window.activeTextEditor;
    if (!editor) return;
    const { document } = editor;

    const selection = editor.selection;
    const aboveSelectionLine = selection.start.line - 1;
    const belowSelectionLine = selection.end.line + 1;

    const documentStart = new Position(0, 0);
    const aboveSelection = new Position(aboveSelectionLine, document.lineAt(aboveSelectionLine).text.length);
    const belowSelection = new Position(belowSelectionLine, document.lineAt(belowSelectionLine).text.length);
    const documentEnd = new Position(document.lineCount, 0);

    editor.selections = [new Selection(documentStart, aboveSelection), new Selection(documentEnd, belowSelection)];

    const firstLineRange = new Range(0, 0, 0, document.lineAt(0).text.length);
    const belowSelectionLineRange = new Range(
      belowSelectionLine,
      0,
      belowSelectionLine,
      document.lineAt(belowSelectionLine).text.length
    );

    editor.setDecorations(this.zenModeDecoration, [firstLineRange, belowSelectionLineRange]);

    this.bookmarksManager.bookmarks = [];
    this.bookmarksManager.addBookmark(editor, documentStart);
    this.bookmarksManager.addBookmark(editor, belowSelection);

    await commands.executeCommand("editor.createFoldingRangeFromSelection");

    editor.selection = selection;
  }

  public async disableZenFolding() {
    const editor = window.activeTextEditor;
    if (!editor) return;

    const selection = editor.selection;

    const manualFoldsSelections = this.bookmarksManager.bookmarks.map((b) => new Selection(b.line, 0, b.line, 0));
    editor.selections = manualFoldsSelections;
    await commands.executeCommand("editor.removeManualFoldingRanges");
    this.bookmarksManager.bookmarks = [];
    editor.setDecorations(this.zenModeDecoration, []);

    editor.selection = selection;
    await commands.executeCommand("revealLine", { lineNumber: selection.start.line, at: "center" });
  }

  public triggerUpdateDecorations(editor?: TextEditor) {
    if (!this.timeout) {
      this.updateDecorations(editor);

      this.timeout = setTimeout(() => {
        clearTimeout(this.timeout);
        this.timeout = undefined;
      }, 100);
    }
  }

  private updateDecorations(editor?: TextEditor) {
    if (editor) this.updateEditorDecorations(editor);
    else {
      for (const editor of window.visibleTextEditors) {
        this.updateEditorDecorations(editor);
      }
    }
  }

  private async updateEditorDecorations(editor: TextEditor) {
    this.cacheFoldedLines(editor.visibleRanges, editor);

    const foldingRanges = await this.getRanges(editor.document);
    this.clearDecorations(editor);

    this.updateZenDecorations(editor);

    const decorationOptions = this.createDecorationsOptions(foldingRanges);
    const newDecorations = this.applyDecorations(editor, foldingRanges, decorationOptions);
    this.setDecorations(editor, newDecorations);
  }

  private clearDecorations(editor?: TextEditor) {
    if (editor) {
      for (const decoration of this.getDecorations(editor)) {
        decoration.dispose();
      }
      editor.setDecorations(this.unfoldedDecoration, []);
      editor.setDecorations(this.zenModeDecoration, []);
    } else {
      for (const decorations of this.decorations.values()) {
        decorations.forEach((decoration) => decoration.dispose());
      }
      this.unfoldedDecoration.dispose();
      this.zenModeDecoration.dispose();
    }
  }

  private updateZenDecorations(editor: TextEditor) {
    if (!editor.visibleRanges.length) return;

    const zenLines = this.bookmarksManager.bookmarks.map((b) => b.line);

    const lastVisibleLine = editor.visibleRanges[editor.visibleRanges.length - 1].end.line;
    const cachedFoldedLines = this.getCachedFoldedLines(editor);

    const zenFoldedLines = zenLines.filter((line) => cachedFoldedLines?.includes(line) || line === lastVisibleLine);
    const decorationRanges = zenFoldedLines.map(
      (line) => new Range(line, 0, line, editor.document.lineAt(line).text.length)
    );

    editor.setDecorations(this.zenModeDecoration, decorationRanges);
  }

  private async getRanges(document: TextDocument): Promise<BetterFoldingRange[]> {
    const excludedLanguages = config.excludedLanguages();
    if (excludedLanguages.includes(document.languageId)) return [];

    const ranges: BetterFoldingRange[] = [];

    const languageProviders = this.providers[document.languageId] ?? [];
    const universalProviders = this.providers["*"] ?? [];
    const allProviders = [...languageProviders, ...universalProviders];

    for (const provider of allProviders) {
      const providerRanges = await provider.provideFoldingRanges(document, undefined, undefined, true);
      ranges.push(...providerRanges);
    }

    return ranges;
  }

  private createDecorationsOptions(foldingRanges: BetterFoldingRange[]): DecorationRenderOptions[] {
    const decorations: Record<string, DecorationRenderOptions> = {};

    for (const foldingRange of foldingRanges) {
      const collapsedText = foldingRange.collapsedText ?? DEFAULT_COLLAPSED_TEXT;
      if (!(collapsedText in decorations)) {
        decorations[collapsedText] = this.newDecorationOption(collapsedText);
      }
    }

    return Object.values(decorations);
  }

  private newDecorationOption(contentText: string): DecorationRenderOptions {
    return {
      textDecoration: "none; display:none;", //Hides the folded text
      before: {
        //Apparently if you add width and height (any values), the text will be clickable
        width: "0",
        height: "0",
        contentText,
        color: "rgba(255, 255, 255, 0.5)", //TODO: Get this from the theme
        margin: `0 -${90}% 0 0`, //Hides the original collapsed text '…'
        textDecoration: "none; cursor: pointer !important;",
      },
    };
  }

  private applyDecorations(
    editor: TextEditor,
    foldingRanges: BetterFoldingRange[],
    decorationOptions: DecorationRenderOptions[]
  ): TextEditorDecorationType[] {
    const collapsedTextToFoldingRanges = groupArrayToMap(foldingRanges, (foldingRange) => foldingRange.collapsedText);

    const decorations: TextEditorDecorationType[] = [];

    const unfoldedRanges: Range[] = [];
    for (const decorationOption of decorationOptions) {
      const decoration = window.createTextEditorDecorationType(decorationOption);
      decorations.push(decoration);

      const foldingRanges = collapsedTextToFoldingRanges.get(decorationOption.before!.contentText!)!;
      const ranges: Range[] = foldingRanges.map(foldingRangeToRange(editor.document));

      const foldedRanges: Range[] = [];
      for (const range of ranges) {
        if (this.isFolded(range, editor)) foldedRanges.push(range);
        else unfoldedRanges.push(range);
      }

      const inlineFoldedRanges = foldedRanges.map(rangeToInlineRange(editor.document));

      editor.setDecorations(decoration, inlineFoldedRanges);
    }
    editor.setDecorations(this.unfoldedDecoration, unfoldedRanges);

    return decorations;
  }

  private isFolded(range: Range, editor: TextEditor): boolean {
    for (const cachedFoldedLine of this.getCachedFoldedLines(editor)) {
      if (cachedFoldedLine === range.start.line) return true;
    }
    return this.checkRangeAtEndOfDocumentCase(range, editor);
  }

  //TODO: clean this up.
  //Band-aid fix for now.
  private checkRangeAtEndOfDocumentCase(range: Range, editor: TextEditor) {
    const lastLine = editor.document.lineCount - 1;
    const justBeforeLastLine = lastLine - 1;
    const rangeAtEndOfDocument = range.end.line === lastLine || range.end.line === justBeforeLastLine;

    const lastVisibleLine = editor.visibleRanges[editor.visibleRanges.length - 1].end.line;

    if (rangeAtEndOfDocument && lastVisibleLine <= range.start.line) {
      this.getCachedFoldedLines(editor).push(range.start.line);
      return true;
    }
    this.setCachedFoldedLines(
      editor,
      this.getCachedFoldedLines(editor).filter((line) => line !== range.start.line)
    );
    return false;
  }

  private cacheFoldedLines(visibleRanges: readonly Range[], editor: TextEditor) {
    if (visibleRanges.length === 0) return;
    const cachedLines = this.getCachedFoldedLines(editor);
    const currentFoldedLines = visibleRanges.slice(0, -1).map((range) => range.end.line);

    if (cachedLines.length === 0) {
      this.setCachedFoldedLines(editor, currentFoldedLines);
      return;
    }

    //TODO: Optimize this.
    //Match the folded lines between editor and cached lines.
    const newFoldedLines = currentFoldedLines.filter((line) => !cachedLines.includes(line));
    cachedLines.push(...newFoldedLines);
    cachedLines.sort((a, b) => a - b);

    //Match the unfolded lines between editor and cached lines.
    const currentFoldedLinesSet = new Set(currentFoldedLines);
    const cachedLinesMinusUnfoldedLines = cachedLines.filter(
      (line) =>
        currentFoldedLinesSet.has(line) ||
        line < visibleRanges[0].start.line ||
        line >= visibleRanges[visibleRanges.length - 1].end.line
    );
    this.setCachedFoldedLines(editor, cachedLinesMinusUnfoldedLines);
  }

  private getDecorations(editor: TextEditor): TextEditorDecorationType[] {
    return this.decorations.get(editor.document.uri);
  }

  private setDecorations(editor: TextEditor, decorations: TextEditorDecorationType[]) {
    this.decorations.set(editor.document.uri, decorations);
  }

  private getCachedFoldedLines(editor: TextEditor): number[] {
    return this.cachedFoldedLines.get(editor.document.uri);
  }

  private setCachedFoldedLines(editor: TextEditor, lines: number[]) {
    this.cachedFoldedLines.set(editor.document.uri, lines);
  }

  public dispose() {
    this.clearDecorations();
  }
}
