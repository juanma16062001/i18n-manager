import { workspace, Uri, ExtensionContext, TextDocument } from 'vscode';
import { parse } from 'node-html-parser';
import { Walker, WalkerResult } from './walker';
import { Observable, ReplaySubject, Subject, of, from, combineLatest } from 'rxjs';
import { takeUntil, map, share } from 'rxjs/operators';

export type WalkerByIdResult = WalkerResult & {
    file: Uri;
};

export class WorkspaceScanner {
    private static _instance: WorkspaceScanner | undefined;

    static get instance(): WorkspaceScanner {
        if (!WorkspaceScanner._instance) {
            WorkspaceScanner._instance = new WorkspaceScanner();
        }
        return WorkspaceScanner._instance;
    }


    private _resultsByFile$ = new ReplaySubject<ReadonlyMap<String, WalkerResult[]>>(1);
    private _resultsById$ = new ReplaySubject<ReadonlyMap<String, WalkerByIdResult[]>>(1);

    private _resultsByFile: ReadonlyMap<String, WalkerResult[]> | undefined;
    private _resultsById: ReadonlyMap<String, WalkerByIdResult[]> | undefined;

    private _state: 'uninitialized' | 'initializing' | 'initialized' = 'uninitialized';
    private _onDestroy$ = new Subject<void>();

    readonly resultsByFile$ = this._resultsByFile$.asObservable();
    readonly resultsById$ = this._resultsById$.asObservable();
    readonly validatedResultsById$ = this._resultsById$.pipe(
        map(res => {
            var copy = new Map<String, WalkerByIdResult[]>(res);
            copy.forEach((results, key) => {
                var resultsCopy = [...results];
                const values = resultsCopy.map(result => result.value).filter(Boolean) as string[];
                var stripped0 = this.strippedString(values[0]);
                if (values.length > 1 && values.some(value => this.strippedString(value) !== stripped0)) {
                    for (let i = 0; i < resultsCopy.length; i++) {
                        resultsCopy[i] = { ...resultsCopy[i], state: 'error', error: 'There are other items registered with this ID whose value do not match!' };
                    }
                }
                for(let i = 0; i < resultsCopy.length; i++){
                    const result = resultsCopy[i];
                    if(result.state !== 'success'){
                        continue;
                    }
                    const value = result.value;
                    if(value && value.indexOf('<') !== -1){
                        resultsCopy[i] = {...result, state: 'warning', error: 'This translation contains HTML tag. This is not recommended!'};
                    }
                }
                copy.set(key, resultsCopy);
            });
            return copy as ReadonlyMap<String, WalkerByIdResult[]>;
        }),
        share(),
        takeUntil(this._onDestroy$)
    );

    get initialized(): boolean { return this._state === 'initialized'; }

    private constructor() {
        this.resultsByFile$.pipe(takeUntil(this._onDestroy$)).subscribe(res => this._resultsByFile = res);
        this.resultsById$.pipe(takeUntil(this._onDestroy$)).subscribe(res => this._resultsById = res);
    }

    private strippedString(str: string): string {
        if (!str) {
            return str;
        }
        return str.replace(/[\n\r]/gi, '').replace(/{{[^}]+}}/gi, '{}').replace(/ +/g, ' ');
    }

    private onDocumentSave(document: TextDocument): void {
        if (!document.uri.path.endsWith('.html')) { return; }
        // we didn't initialize for some reason?
        if (!this._resultsByFile || !this._resultsById) { return console.error('[i18n-manager] We were not able to handle a saved document'); }

        const results = this.getI18nResultsForFile(document);
        var newFileMap = new Map<String, WalkerResult[]>(this._resultsByFile);
        newFileMap.set(document.uri.toString(), results);

        const newIdMap = new Map<String, WalkerByIdResult[]>(this._resultsById);

        // remove old id maps
        const oldRegistry = this._resultsByFile.get(document.uri.toString());
        if (oldRegistry) {
            oldRegistry.forEach(res => {
                const entry = newIdMap.get(res.id);
                if (entry) {
                    const fileIndex = entry.findIndex(c => c.file.toString() === document.uri.toString());
                    if (fileIndex !== -1) {
                        entry.splice(fileIndex, 1);
                        if (entry.length === 0) {
                            newIdMap.delete(res.id);
                        }
                    }
                }
            });
        }

        // add new id maps
        results.forEach(res => {
            const entry = newIdMap.get(res.id);
            const newRecord = { ...res, file: document.uri };
            if (entry) {
                entry.push(newRecord);
            } else {
                newIdMap.set(res.id, [newRecord]);
            }
        });

        this._resultsByFile$.next(newFileMap);
        this._resultsById$.next(newIdMap);
    }

    private registerEvents(context: ExtensionContext): void {
        const savedDocumentSubject = new Subject<TextDocument>();
        const disposable = workspace.onDidSaveTextDocument(doc => {
            if (this._state === 'initialized') {
                savedDocumentSubject.next(doc);
            } else {
                let interval: undefined | NodeJS.Timeout;
                interval = setInterval(() => {
                    if (this._state === 'initialized') {
                        savedDocumentSubject.next(doc);
                        if (interval) { clearInterval(interval); }
                    }
                }, 1000);
            }
        });
        savedDocumentSubject.pipe(takeUntil(this._onDestroy$)).subscribe(savedTextDocument => this.onDocumentSave(savedTextDocument));

        context.subscriptions.push(disposable);
    }

    private getI18nResultsForFile(document: TextDocument): WalkerResult[] {
        const text = document.getText();
        if (!text) {
            return [];
        }
        const parsed = parse(text);
        const walker = new Walker(parsed);
        return walker.geti18nAttributes();
    }

    initialize(context: ExtensionContext): Observable<void> {
        if (this._state !== 'uninitialized') {
            return of(undefined);
        }
        console.log('[i18n-manager] initializing i18n repository');
        this.registerEvents(context);
        this._state = 'initializing';

        const resultByFileName = new Map<String, WalkerResult[]>();
        const resultById = new Map<String, WalkerByIdResult[]>();
        const finalizeSubject$ = new Subject<void>();

        workspace.findFiles('**/*.html').then(files => {
            const promises: Thenable<void>[] = [];
            files.forEach(uri => {
                promises.push(workspace.openTextDocument(uri).then(document => {
                    const walkerResults = this.getI18nResultsForFile(document);
                    if (walkerResults.length > 0) {
                        resultByFileName.set(uri.toString(), walkerResults);
                        walkerResults.forEach(walkerResult => {
                            const entry = resultById.get(walkerResult.id);
                            const newRecord = { ...walkerResult, file: uri };
                            if (entry) {
                                entry.push(newRecord);
                            } else {
                                resultById.set(walkerResult.id, [newRecord]);
                            }
                        });
                    }
                }));
            });

            Promise.all(promises).then(() => {
                this._state = 'initialized';
                this._resultsByFile$.next(resultByFileName);
                this._resultsById$.next(resultById);
                finalizeSubject$.next();
                finalizeSubject$.complete();
                console.log('[i18n-manager] initialized i18n repository');
            }).catch(err => {
                console.error(`[i18n-manager]: Failed to initialize i18n repository: ${err}`);
            });
        });
        return finalizeSubject$.asObservable();
    }

    static deactivate() {
        if (!this._instance) {
            return;
        }
        this.instance._resultsByFile$.complete();
        this.instance._resultsById$.complete();
        this.instance._onDestroy$.next();
        this.instance._onDestroy$.complete();
        this._instance = undefined;
    }
}
