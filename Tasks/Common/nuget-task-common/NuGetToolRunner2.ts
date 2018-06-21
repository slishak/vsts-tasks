import * as url from "url";
import * as tl from "vsts-task-lib/task";
import {IExecOptions, IExecSyncResult, ToolRunner} from "vsts-task-lib/toolrunner";

import * as auth from "./Authentication";
import {NuGetQuirkName, NuGetQuirks, defaultQuirks} from "./NuGetQuirks";
import * as ngutil from "./Utility";
import * as peParser from "./pe-parser";
import * as commandHelper from "./CommandHelper";

// NuGetToolRunner2 can handle environment setup for new authentication scenarios where
// we are accessing internal or external package sources.
// It is used by the NuGetCommand >= v2.0.0 and DotNetCoreCLI >= v2.0.0

interface EnvironmentDictionary { [key: string]: string; }

export interface NuGetEnvironmentSettings {
    /* V1 credential provider folder path */
    credProviderFolder?: string;
    /* V2 credential provider path */
    V2CredProviderPath?: string
    extensionsDisabled: boolean;
}

function prepareNuGetExeEnvironment(
    input: EnvironmentDictionary,
    settings: NuGetEnvironmentSettings,
    authInfo: auth.NuGetExtendedAuthInfo): EnvironmentDictionary {

    let env: EnvironmentDictionary = {};
    let envVarCredProviderPathV1: string = null;
    let envVarCredProviderPathV2: string = null;
    let prefix: string = null;

    for (let e in input) {
        if (!input.hasOwnProperty(e)) {
            continue;
        }
        // NuGet.exe extensions only work with a single specific version of nuget.exe. This causes problems
        // whenever we update nuget.exe on the agent.
        if (e.toUpperCase() === "NUGET_EXTENSIONS_PATH") {
            if (settings.extensionsDisabled) {
                tl.warning(tl.loc("NGCommon_IgnoringNuGetExtensionsPath"));
                continue;
            } else {
                console.log(tl.loc("NGCommon_DetectedNuGetExtensionsPath", input[e]));
            }
        }

        // New credential provider
        if (e.toUpperCase() === "NUGET_PLUGIN_PATHS") {
            envVarCredProviderPathV2 = input[e];
            continue;
        }

        // Old credential provider
        if (e.toUpperCase() === "NUGET_CREDENTIALPROVIDERS_PATH") {
            envVarCredProviderPathV1 = input[e];
            continue;
        }

        env[e] = input[e];
    }

    if (authInfo && authInfo.internalAuthInfo) {
        env["VSS_NUGET_ACCESSTOKEN"] = authInfo.internalAuthInfo.accessToken;
        env["VSS_NUGET_URI_PREFIXES"] = authInfo.internalAuthInfo.uriPrefixes.join(";");
    }

    env["NUGET_CREDENTIAL_PROVIDER_OVERRIDE_DEFAULT"] = "true";

    let credProviderPath = null;
    // If NUGET_CREDENTIALPROVIDERS_PATH is provided
    // use old cred provider regardles of which version on NuGet
    if (settings.credProviderFolder != null || envVarCredProviderPathV1 != null) {
        credProviderPath = buildCredProviderPath(settings.credProviderFolder, envVarCredProviderPathV1);

        if (credProviderPath) {
            env["NUGET_CREDENTIALPROVIDERS_PATH"] = credProviderPath;
            tl.debug(`Using V1 credential provider`);
        }
    } else {
        credProviderPath = buildCredProviderPath(settings.V2CredProviderPath, envVarCredProviderPathV2);

        if (credProviderPath) {
            env["NUGET_PLUGIN_PATHS"] = credProviderPath;
            tl.debug(`Using V2 credential provider`);
        }
    }
    tl.debug(`credProviderPath = ${credProviderPath}`);    

    let httpProxy = getNuGetProxyFromEnvironment();
    if (httpProxy) {
        tl.debug(`Adding environment variable for NuGet proxy: ${httpProxy}`);
        env["HTTP_PROXY"] = httpProxy;
    }

    return env;
}

function buildCredProviderPath(credProviderPath: string, envVarCredProviderPath: string): string {
    let result = credProviderPath || envVarCredProviderPath;
    if (credProviderPath && envVarCredProviderPath) {
        result = credProviderPath + ";" + envVarCredProviderPath;
    }
    return result;
}

export class NuGetToolRunner2 extends ToolRunner {
    private settings: NuGetEnvironmentSettings;
    private authInfo: auth.NuGetExtendedAuthInfo;

    constructor(nuGetExePath: string, settings: NuGetEnvironmentSettings, authInfo: auth.NuGetExtendedAuthInfo) {
        if (tl.osType() === 'Windows_NT' || !nuGetExePath.trim().toLowerCase().endsWith(".exe")) {
            super(nuGetExePath);
        }
        else {
            let monoPath = tl.which("mono", true);
            super(monoPath);
            this.arg(nuGetExePath);
        }

        this.settings = settings;
        this.authInfo = authInfo;
    }

    public execSync(options?: IExecOptions): IExecSyncResult {
        options = options || <IExecOptions>{};
        options.env = prepareNuGetExeEnvironment(options.env || process.env, this.settings, this.authInfo);
        return super.execSync(options);
    }

    public exec(options?: IExecOptions): Q.Promise<number> {
        options = options || <IExecOptions>{};
        options.env = prepareNuGetExeEnvironment(options.env || process.env, this.settings, this.authInfo);
        return super.exec(options);
    }
}

export function createNuGetToolRunner(nuGetExePath: string, settings: NuGetEnvironmentSettings, authInfo: auth.NuGetExtendedAuthInfo): NuGetToolRunner2 {
    let runner = new NuGetToolRunner2(nuGetExePath, settings, authInfo);
    runner.on("debug", message => tl.debug(message));
    return runner;
}

export async function getNuGetQuirksAsync(nuGetExePath: string): Promise<NuGetQuirks> {
    try {
        const version = await peParser.getFileVersionInfoAsync(nuGetExePath);
        const quirks = NuGetQuirks.fromVersion(version.fileVersion);

        console.log(tl.loc("NGCommon_DetectedNuGetVersion", version.fileVersion, version.strings.ProductVersion));
        tl.debug(`Quirks for ${version.fileVersion}:`);
        quirks.getQuirkNames().forEach(quirk => {
            tl.debug(`    ${quirk}`);
        });

        return quirks;
    } catch (err) {
        if (err.code && (
            err.code === "invalidSignature"
            || err.code === "noResourceSection"
            || err.code === "noVersionResource")) {

            tl.debug("Cannot read version from NuGet. Using default quirks:");
            defaultQuirks.forEach(quirk => {
                tl.debug(`    ${NuGetQuirkName[quirk]}`);
            });
            return new NuGetQuirks(null, defaultQuirks);
        }

        throw err;
    }
}

// Currently, there is a race condition of some sort that causes nuget to not send credentials sometimes
// when using the credential provider.
// Unfortunately, on on-premises TFS, we must use credential provider to override NTLM auth with the build
// identity's token.
// Therefore, we are enabling credential provider on on-premises and disabling it on hosted (only when the version of NuGet does not support it). We allow for test
// instances by an override variable.
export function isCredentialProviderV1Enabled(quirks: NuGetQuirks): boolean {
    if (quirks.hasQuirk(NuGetQuirkName.V2CredentialProvider)) {
        tl.debug("V1 credential provider not enabled.");
        return false;
    }

    return isCredentialProviderEnabled(quirks);
}

export function isCredentialProviderV2Enabled(quirks: NuGetQuirks): boolean {
    if (quirks.hasQuirk(NuGetQuirkName.V2CredentialProvider) === false) {
        tl.debug("V2 credential provider not enabled.");
        return false;
    }

    return isCredentialProviderEnabled(quirks);
}

function isCredentialProviderEnabled(quirks: NuGetQuirks): boolean {
    // set NuGet.ForceEnableCredentialProvider to "true" to force allowing the credential provider flow, "false"
    // to force *not* allowing the credential provider flow, or unset/anything else to fall through to the 
    // hosted environment detection logic
    const credentialProviderOverrideFlag = tl.getVariable("NuGet.ForceEnableCredentialProvider");
    if (credentialProviderOverrideFlag === "true") {
        tl.debug("Credential provider is force-enabled for testing purposes.");
        return true;
    }

    if (credentialProviderOverrideFlag === "false") {
        tl.debug("Credential provider is force-disabled for testing purposes.");
        return false;
    }

    if (quirks.hasQuirk(NuGetQuirkName.NoCredentialProvider)
        || quirks.hasQuirk(NuGetQuirkName.CredentialProviderRace)) {
        tl.debug("Credential provider is disabled due to quirks.");
        return false;
    }

    if (commandHelper.isOnPremisesTfs() && (
        quirks.hasQuirk(NuGetQuirkName.NoTfsOnPremAuthCredentialProvider))) {
        tl.debug("Credential provider is disabled due to on-prem quirks.");
        return false;
    }

    tl.debug("Credential provider is enabled.");
    return true;
}

export function isCredentialConfigEnabled(quirks: NuGetQuirks): boolean {
    // set NuGet.ForceEnableCredentialConfig to "true" to force allowing config-based credential flow, "false"
    // to force *not* allowing config-based credential flow, or unset/anything else to fall through to the 
    // hosted environment detection logic
    const credentialConfigOverrideFlag = tl.getVariable("NuGet.ForceEnableCredentialConfig");
    if (credentialConfigOverrideFlag === "true") {
        tl.debug("Credential config is force-enabled for testing purposes.");
        return true;
    }

    if (credentialConfigOverrideFlag === "false") {
        tl.debug("Credential config is force-disabled for testing purposes.");
        return false;
    }

    if (commandHelper.isOnPremisesTfs() && (
        quirks.hasQuirk(NuGetQuirkName.NoTfsOnPremAuthConfig))) {
        tl.debug("Credential config is disabled due to on-prem quirks.");
        return false;
    }

    tl.debug("Credential config is enabled.");
    return true;
}

export function getNuGetProxyFromEnvironment(): string {
    let proxyUrl: string = tl.getVariable("agent.proxyurl");
    let proxyUsername: string = tl.getVariable("agent.proxyusername");
    let proxyPassword: string = tl.getVariable("agent.proxypassword");

    if (proxyUrl !== undefined) {
        let proxy: url.Url = url.parse(proxyUrl);

        if (proxyUsername !== undefined) {
            proxy.auth = proxyUsername;

            if (proxyPassword !== undefined) {
                proxy.auth += `:${proxyPassword}`;
            }
        }

        return url.format(proxy);
    }

    return undefined;
}
