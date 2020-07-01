import * as core from "@actions/core"
import { context, getOctokit } from "@actions/github"

type GitHub = ReturnType<typeof getOctokit>

async function mergePr(client: GitHub, prNumber: number): Promise<void> {
    const opts = {
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: prNumber,
    }
    const { data: pr } = await client.pulls.get({ ...opts })
    if (pr.mergeable_state != "clean") {
        core.debug(`mergeable state is not clean: ${pr.mergeable_state}`)
        return
    }

    const commits = await client.pulls.listCommits({ ...opts })
    const authors = new Set<string>()
    for (const c of commits.data) {
        authors.add(`Authored-by: ${c.commit.author.name} <${c.commit.author.email}>`)
    }
    if (commits.data.length == 1) {
        const msg = commits.data[0].commit.message
        const divider = msg.indexOf("\n")
        const title = msg.slice(0, divider)
        const body = msg.slice(divider)
        await client.pulls.merge({
            ...opts,
            merge_method: "squash",
            commit_title: title + ` (#${pr.number})`,
            commit_message: body,
        })
    } else {
        await client.pulls.merge({
            ...opts,
            merge_method: "merge",
            commit_title: "merge: " + pr.title + ` (#${pr.number})`,
            commit_message: `"${pr.body}"\n\n${Array.from(authors.values()).join("\n")}`,
        })
    }
}

async function checkPullRequestsForBranches(client: GitHub, branchName: string): Promise<void> {
    console.log("Listing pull requests for", branchName, "...")
    const { data: pullRequests } = await client.pulls.list({
        owner: context.repo.owner,
        repo: context.repo.repo,
        state: "open",
        head: `${context.repo.owner}:${branchName}`,
        sort: "updated",
        direction: "desc",
        per_page: 100,
    })

    core.debug(`PR list: ${pullRequests}`)
    for (const pr of pullRequests) {
        try {
            await mergePr(client, pr.number)
        } catch (e) {
            core.error(e)
        }
    }
}

async function handleStatusUpdate(client: GitHub): Promise<void> {
    if (!process.env.GITHUB_EVENT_PATH) {
        throw new Error("Missing event path")
    }
    const { state, branches } = require(process.env.GITHUB_EVENT_PATH)
    if (state !== "success") {
        console.log("Status change ignored")
        return
    }

    if (!branches || branches.length === 0) {
        console.log("No branches have been referenced")
        return
    }

    for (const branch of branches) {
        await checkPullRequestsForBranches(client, branch.name)
    }
}

async function handlePullRequestUpdate(client: GitHub): Promise<void> {
    if (context.payload.pull_request) {
        await mergePr(client, context.payload.pull_request.number)
    } else {
        console.error("Missing pull request context")
    }
}

async function handleCheckUpdate(client: GitHub, eventName: string): Promise<void> {
    if (context.payload.action !== "completed") {
        console.log("Check not yet finished")
        return
    }

    if (!process.env.GITHUB_EVENT_PATH) {
        throw new Error("Missing event path")
    }
    const event = require(process.env.GITHUB_EVENT_PATH)
    const payload = eventName === "check_suite" ? event.check_suite : event.check_run
    if (payload.conclusion === "success") {
        const checkPullRequest = payload.pull_requests[0]
        if (checkPullRequest != null) {
            await mergePr(client, checkPullRequest.number)
        } else {
            const branchName = payload.head_branch
            if (branchName != null) {
                await checkPullRequestsForBranches(client, branchName)
            } else {
                console.log("Could not find branch name in this status check result")
            }
        }
    }
}

async function handle(client: GitHub): Promise<void> {
    const eventName = process.env["GITHUB_EVENT_NAME"]
    core.debug(eventName || "")
    if (eventName === "status") {
        await handleStatusUpdate(client)
    } else if (eventName === "pull_request" || eventName === "pull_request_review") {
        await handlePullRequestUpdate(client)
    } else if (eventName === "check_suite" || eventName === "check_run") {
        await handleCheckUpdate(client, eventName)
    }
}

async function run(): Promise<void> {
    try {
        const token = core.getInput("repo-token", { required: true })
        const client = getOctokit(token)
        await handle(client)
    } catch (error) {
        core.error(error.message)
        core.setFailed(error.message)
    }
}

run()
