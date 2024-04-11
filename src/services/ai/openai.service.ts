import chalk from 'chalk';
import { ReactiveListChoice } from 'inquirer-reactive-list-prompt';
import { Observable, catchError, concatMap, from, map, of, scan } from 'rxjs';
import { fromPromise } from 'rxjs/internal/observable/innerFrom';

import { AIService, AIServiceError, AIServiceParams } from './ai.service.js';
import { generateCommitMessage } from '../../utils/openai.js';

export class OpenAIService extends AIService {
    constructor(private readonly params: AIServiceParams) {
        super(params);
        this.colors = {
            primary: '#74AA9C',
            secondary: '#FFF',
        };
        this.serviceName = chalk.bgHex(this.colors.primary).hex(this.colors.secondary).bold('[ChatGPT]');
        this.errorPrefix = chalk.red.bold(`[ChatGPT]`);
    }

    generateNumbers1 = () => {
        let currentNumber = 1;
        let fullText = '';
        return new Observable(observer => {
            const intervalId = setInterval(() => {
                if (currentNumber <= 10) {
                    observer.next({
                        id: 'OPENAI',
                        name: `${this.serviceName} ${fullText}`,
                        value: fullText,
                        isError: false,
                        done: false,
                        disabled: true,
                    });
                    currentNumber++;
                    fullText += currentNumber;
                } else {
                    observer.next({
                        id: 'OPENAI',
                        name: `${this.serviceName} ${fullText}`,
                        value: `${fullText}`,
                        isError: false,
                        done: true,
                        disabled: false,
                    });

                    clearInterval(intervalId);
                    observer.complete();
                }
            }, 200);

            return () => {
                clearInterval(intervalId);
            };
        });
    };

    generateCommitMessage$(): Observable<ReactiveListChoice> {
        return from(this.generateNumbers1()).pipe(
            scan((acc: any, data: any) => {
                if (data.done) {
                    const messages = [
                        'feat: Add new user profile page',
                        'fix: Correct typo in API endpoint',
                        'refactor: Improve code structure for better readability',
                    ];
                    return messages.map((message, index) => {
                        return {
                            id: 'OPENAI' + index,
                            name: `${this.serviceName} ${message}`,
                            value: `${message}`,
                            isError: false,
                            done: true,
                            disabled: false,
                        };
                    }) as any;
                }
                // if has data
                const originData = acc.find((origin: any) => origin.id === data.id);
                if (originData) {
                    return [...acc.map(origin => (data.id === origin.id ? data : origin))];
                }
                // init
                return [{ ...data }] as any;
            }, []),
            concatMap(messages => {
                console.log(messages);
                return from(messages);
            }) // flat messages
        );
        ////

        return fromPromise(
            generateCommitMessage(
                this.params.config.OPENAI_URL,
                this.params.config.OPENAI_PATH,
                this.params.config.OPENAI_KEY,
                this.params.config.OPENAI_MODEL,
                this.params.config.locale,
                this.params.stagedDiff.diff,
                this.params.config.generate,
                this.params.config['max-length'],
                this.params.config.type,
                this.params.config.timeout,
                this.params.config['max-tokens'],
                this.params.config.temperature,
                this.params.config.prompt,
                this.params.config.proxy
            )
        ).pipe(
            concatMap(messages => from(messages)), // flat messages
            map(message => ({
                name: `${this.serviceName} ${message}`,
                value: message,
                isError: false,
            })),
            catchError(this.handleError$)
        );
    }

    handleError$ = (error: AIServiceError) => {
        let simpleMessage = 'An error occurred';
        if (error.message) {
            simpleMessage = error.message.split('\n')[0];
            const errorJson = this.extractJSONFromError(error.message);
            simpleMessage += `: ${errorJson.error.message}`;
        }
        return of({
            name: `${this.errorPrefix} ${simpleMessage}`,
            value: simpleMessage,
            isError: true,
        });
    };

    private extractJSONFromError(error: string) {
        const regex = /[{[]{1}([,:{}[\]0-9.\-+Eaeflnr-u \n\r\t]|".*?")+[}\]]{1}/gis;
        const matches = error.match(regex);
        if (matches) {
            return Object.assign({}, ...matches.map((m: any) => JSON.parse(m)));
        }
        return {
            error: {
                message: 'Unknown error',
            },
        };
    }
}
