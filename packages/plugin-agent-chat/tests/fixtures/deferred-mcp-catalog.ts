import type { ExecutableTool } from '@keundal/tools'

const actions = ['search', 'get', 'list', 'create', 'update', 'delete', 'export', 'watch', 'count', 'validate']

const groups = [
  {
    server: 'github',
    area: 'issues',
    description: 'GitHub issue',
    schema: {
      owner: { type: 'string' },
      repository: { type: 'string' },
      state: { type: 'string', enum: ['open', 'closed', 'all'] },
      labels: { type: 'array', items: { type: 'string' } },
      filter: { type: 'object', properties: { milestone: { type: 'string' }, assignee: { type: 'string' } } },
      pagination: {
        type: 'object',
        properties: { page: { type: 'integer' }, perPage: { type: 'integer', maximum: 100 } }
      }
    },
    required: ['owner', 'repository']
  },
  {
    server: 'github',
    area: 'pull_requests',
    description: 'GitHub pull request',
    schema: {
      owner: { type: 'string' },
      repository: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      state: { type: 'string', enum: ['open', 'closed', 'merged', 'all'] },
      reviewer: { type: 'string' },
      pagination: {
        type: 'object',
        properties: { cursor: { type: 'string' }, limit: { type: 'integer', maximum: 100 } }
      }
    },
    required: ['owner', 'repository']
  },
  {
    server: 'github',
    area: 'repositories',
    description: 'GitHub repository',
    schema: {
      owner: { type: 'string' },
      query: { type: 'string' },
      visibility: { type: 'string', enum: ['public', 'private', 'internal'] },
      sort: { type: 'string', enum: ['created', 'updated', 'pushed', 'full_name'] },
      topics: { type: 'array', items: { type: 'string' } },
      pagination: { type: 'object', properties: { page: { type: 'integer' }, perPage: { type: 'integer' } } }
    },
    required: ['owner']
  },
  {
    server: 'google_drive',
    area: 'documents',
    description: 'Google Drive document',
    schema: {
      query: { type: 'string' },
      mimeType: { type: 'string', enum: ['document', 'spreadsheet', 'presentation', 'pdf'] },
      filters: {
        type: 'object',
        properties: { owner: { type: 'string' }, modifiedAfter: { type: 'string', format: 'date-time' } }
      },
      orderBy: { type: 'string', enum: ['name', 'modifiedTime', 'createdTime'] },
      pageToken: { type: 'string' },
      pageSize: { type: 'integer', minimum: 1, maximum: 100 }
    },
    required: ['query']
  },
  {
    server: 'google_drive',
    area: 'files',
    description: 'Google Drive file',
    schema: {
      fileId: { type: 'string' },
      folderId: { type: 'string' },
      includeTrashed: { type: 'boolean' },
      fields: { type: 'array', items: { type: 'string', enum: ['id', 'name', 'mimeType', 'owners', 'size'] } },
      pagination: { type: 'object', properties: { pageToken: { type: 'string' }, pageSize: { type: 'integer' } } }
    },
    required: ['fileId']
  },
  {
    server: 'linear',
    area: 'projects',
    description: 'Linear project',
    schema: {
      teamId: { type: 'string' },
      projectId: { type: 'string' },
      status: { type: 'string', enum: ['planned', 'started', 'paused', 'completed', 'canceled'] },
      filter: {
        type: 'object',
        properties: { leadId: { type: 'string' }, targetDateBefore: { type: 'string', format: 'date' } }
      },
      first: { type: 'integer', minimum: 1, maximum: 250 },
      after: { type: 'string' }
    },
    required: ['teamId']
  },
  {
    server: 'google_calendar',
    area: 'events',
    description: 'Google Calendar event',
    schema: {
      calendarId: { type: 'string' },
      timeRange: {
        type: 'object',
        properties: { start: { type: 'string', format: 'date-time' }, end: { type: 'string', format: 'date-time' } },
        required: ['start', 'end']
      },
      attendees: { type: 'array', items: { type: 'string', format: 'email' } },
      visibility: { type: 'string', enum: ['default', 'public', 'private'] },
      maxResults: { type: 'integer', maximum: 2500 },
      pageToken: { type: 'string' }
    },
    required: ['calendarId']
  },
  {
    server: 'aws_cloud',
    area: 'resources',
    description: 'AWS cloud resource',
    schema: {
      accountId: { type: 'string' },
      region: { type: 'string', enum: ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-northeast-2'] },
      resourceType: { type: 'string', enum: ['ec2', 's3', 'lambda', 'rds'] },
      tags: { type: 'object', additionalProperties: { type: 'string' } },
      filters: {
        type: 'array',
        items: {
          type: 'object',
          properties: { key: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } },
          required: ['key', 'values']
        }
      },
      nextToken: { type: 'string' }
    },
    required: ['accountId', 'region']
  },
  {
    server: 'datadog',
    area: 'logs',
    description: 'Datadog log',
    schema: {
      query: { type: 'string' },
      indexes: { type: 'array', items: { type: 'string' } },
      time: {
        type: 'object',
        properties: { from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' } }
      },
      sort: { type: 'string', enum: ['timestamp', '-timestamp'] },
      page: { type: 'object', properties: { limit: { type: 'integer', maximum: 1000 }, cursor: { type: 'string' } } }
    },
    required: ['query']
  },
  {
    server: 'openweathermap',
    area: 'weather',
    description: 'OpenWeatherMap weather data',
    schema: {
      city: { type: 'string' },
      countryCode: { type: 'string', minLength: 2, maxLength: 2 },
      units: { type: 'string', enum: ['standard', 'metric', 'imperial'] },
      language: { type: 'string' },
      days: { type: 'integer', minimum: 1, maximum: 16 },
      include: { type: 'array', items: { type: 'string', enum: ['hourly', 'alerts', 'airQuality'] } }
    },
    required: ['city']
  },
  {
    server: 'slack',
    area: 'messages',
    description: 'Slack message',
    schema: {
      channelId: { type: 'string' },
      query: { type: 'string' },
      userId: { type: 'string' },
      timeRange: { type: 'object', properties: { after: { type: 'string' }, before: { type: 'string' } } },
      sort: { type: 'string', enum: ['score', 'timestamp'] },
      pagination: {
        type: 'object',
        properties: { cursor: { type: 'string' }, limit: { type: 'integer', maximum: 100 } }
      }
    },
    required: ['query']
  },
  {
    server: 'jira',
    area: 'tickets',
    description: 'Jira ticket',
    schema: {
      projectKey: { type: 'string' },
      issueKey: { type: 'string' },
      jql: { type: 'string' },
      status: { type: 'array', items: { type: 'string', enum: ['Open', 'In Progress', 'Resolved', 'Closed'] } },
      fields: { type: 'array', items: { type: 'string' } },
      pagination: {
        type: 'object',
        properties: { startAt: { type: 'integer' }, maxResults: { type: 'integer', maximum: 100 } }
      }
    },
    required: ['projectKey']
  }
] as const

export const TARGET_WEATHER_TOOL = 'mcp__openweathermap__tool__forecast_postal_code'

export function createDeferredMcpCatalog(onWeatherForecast: () => string): ExecutableTool[] {
  return groups.flatMap((group) =>
    actions.map((action) => {
      const target = group.server === 'openweathermap' && action === 'get'
      const name = target ? TARGET_WEATHER_TOOL : `mcp__${group.server}__tool__${group.area}_${action}`
      const description = target
        ? 'Get a weather forecast for a postal code, with hourly conditions and measurement units.'
        : `${group.description} ${action.replaceAll('_', ' ')} operation with filters and pagination.`
      return {
        name,
        description,
        parameters: {
          type: 'object',
          properties: { ...group.schema, ...(target ? { postalCode: { type: 'string' } } : {}) },
          required: target ? ['postalCode'] : [...group.required],
          additionalProperties: false
        },
        execute: () => (target ? onWeatherForecast() : JSON.stringify({ content: [{ type: 'text', text: 'fixture' }] }))
      }
    })
  )
}
