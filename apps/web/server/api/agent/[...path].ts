import { getAgentApp } from '#agent-host-runtime'
import { createAgentHandler } from '../../agent/handler'

export default createAgentHandler(getAgentApp)
