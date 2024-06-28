import { AxiosResponse } from 'axios';
import chalk from 'chalk';
import { ReactiveListChoice } from 'inquirer-reactive-list-prompt';
import { Observable, catchError, concatMap, from, map, of } from 'rxjs';
import { fromPromise } from 'rxjs/internal/observable/innerFrom';

import { AIService, AIServiceError, AIServiceParams } from './ai.service.js';
import { KnownError } from '../../utils/error.js';
import { createLogResponse } from '../../utils/log.js';
import { deduplicateMessages } from '../../utils/openai.js';
import { getRandomNumber } from '../../utils/utils.js';
import { HttpRequestBuilder } from '../http/http-request.builder.js';

export interface MistralServiceError extends AIServiceError {}

export interface ListAvailableModelsResponse {
    object: string;
    data: {
        id: string;
        object: string;
        created: number;
        owned_by: string;
    }[];
}

export interface CreateChatCompletionsResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: {
        index: number;
        message: {
            role: string;
            content: string;
        };
        finish_reason: string;
    }[];
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

export class MistralService extends AIService {
    private use_codestral = this.params.config.MISTRAL_MODEL === 'codestral-latest';
    private host = this.use_codestral ? 'https://codestral.mistral.ai' : 'https://api.mistral.ai';
    private apiKey = '';

    constructor(private readonly params: AIServiceParams) {
        super(params);
        this.colors = {
            primary: this.use_codestral ? '#199910' : '#FC4A0A',
            secondary: '#fff',
        };
        this.serviceName = this.use_codestral
            ? chalk.bgHex(this.colors.primary).hex(this.colors.secondary).bold('[MistralAI-Codestral]')
            : chalk.bgHex(this.colors.primary).hex(this.colors.secondary).bold('[MistralAI]');
        this.errorPrefix = this.use_codestral ? chalk.red.bold(`[MistralAI-Codestral]`) : chalk.red.bold(`[MistralAI]`);
        this.apiKey = this.use_codestral ? this.params.config.CODESTRAL_KEY : this.params.config.MISTRAL_KEY;
        //this.apiKey = this.params.config.MISTRAL_KEY;
    }

    generateCommitMessage$(): Observable<ReactiveListChoice> {
        return fromPromise(this.generateMessage()).pipe(
            concatMap(messages => from(messages)),
            map(message => ({
                name: `${this.serviceName} ${message}`,
                value: message,
                isError: false,
            })),
            catchError(this.handleError$)
        );
    }

    private async generateMessage(): Promise<string[]> {
        try {
            const diff = this.params.stagedDiff.diff;
            const { locale, generate, type, prompt: userPrompt, logging } = this.params.config;
            const maxLength = this.params.config['max-length'];
            const prompt = this.buildPrompt(locale, diff, generate, maxLength, type, userPrompt);
            await this.checkAvailableModels();
            const chatResponse = await this.createChatCompletions(prompt);
            logging && createLogResponse('MistralAI', diff, prompt, chatResponse);
            return deduplicateMessages(this.sanitizeMessage(chatResponse, this.params.config.type, generate));
        } catch (error) {
            const errorAsAny = error as any;
            if (errorAsAny.code === 'ENOTFOUND') {
                throw new KnownError(`Error connecting to ${errorAsAny.hostname} (${errorAsAny.syscall})`);
            }
            throw errorAsAny;
        }
    }

    handleError$ = (error: MistralServiceError) => {
        const simpleMessage = error.message?.replace(/(\r\n|\n|\r)/gm, '') || 'An error occurred';
        return of({
            name: `${this.errorPrefix} ${simpleMessage}`,
            value: simpleMessage,
            isError: true,
            disabled: true,
        });
    };

    private async checkAvailableModels() {
        const availableModels = await this.getAvailableModels();
        if (availableModels.includes(this.params.config.MISTRAL_MODEL)) {
            return true;
        }
        throw new Error(`Invalid model type of Mistral AI`);
    }

    private async getAvailableModels() {
        const response: AxiosResponse<ListAvailableModelsResponse> = await new HttpRequestBuilder({
            method: 'GET',
            // The 'List Available Models' endpoint is only available in the `api.mistral.ai` domain, codestral models included in the response
            // also currently `codestral-latest` points to `codestral-2405` src: https://docs.mistral.ai/getting-started/models/#api-versioning
            baseURL: 'https://api.mistral.ai/v1/models',
            timeout: this.params.config.timeout,
        })
            .setHeaders({
                Authorization: `Bearer ${this.apiKey}`,
                'content-type': 'application/json',
            })
            .execute();

        return response.data.data.filter(model => model.object === 'model').map(model => model.id);
    }

    private async createChatCompletions(prompt: string) {
        const response: AxiosResponse<CreateChatCompletionsResponse> = await new HttpRequestBuilder({
            method: 'POST',
            baseURL: `${this.host}/v1/chat/completions`,
            timeout: this.params.config.timeout,
        })
            .setHeaders({
                Authorization: `Bearer ${this.apiKey}`,
                'content-type': 'application/json',
            })
            .setBody({
                model: this.params.config.MISTRAL_MODEL,
                messages: [
                    {
                        role: 'user',
                        content: prompt,
                    },
                ],
                temperature: this.params.config.temperature,
                top_p: 1,
                max_tokens: this.params.config['max-tokens'],
                stream: false,
                safe_prompt: false,
                random_seed: getRandomNumber(10, 1000),
            })
            .execute();
        const result: CreateChatCompletionsResponse = response.data;
        const hasNoChoices = !result.choices || result.choices.length === 0;
        if (hasNoChoices || !result.choices[0].message?.content) {
            throw new Error(`No Content on response. Please open a Bug report`);
        }
        return result.choices[0].message.content;
    }
}
