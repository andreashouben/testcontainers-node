import Dockerode, { PortMap as DockerodePortBindings } from "dockerode";
import streamToArray from "stream-to-array";
import tar from "tar-fs";
import { BoundPorts } from "./bound-ports";
import { Container, DockerodeContainer } from "./container";
import { Host } from "./docker-client-factory";
import log from "./logger";
import { PortString } from "./port";
import { RepoTag } from "./repo-tag";

export type Command = string;
export type ContainerName = string;
export type ExitCode = number;

export type EnvKey = string;
export type EnvValue = string;
export type Env = { [key in EnvKey]: EnvValue };
type DockerodeEnvironment = string[];

export type Dir = string;

export type TmpFs = { [dir in Dir]: Dir };

export type BuildContext = string;
export type BuildArgs = { [key in EnvKey]: EnvValue };

export type StreamOutput = string;
export type ExecResult = { output: StreamOutput; exitCode: ExitCode };
type DockerodeExposedPorts = { [port in PortString]: {} };

export type DockerInfo = {
  version: string;
  availableMb: number;
};

export type BindMode = "rw" | "ro";
export type BindMount = {
  source: Dir;
  target: Dir;
  bindMode: BindMode;
};
type DockerodeBindMount = string;

type CreateOptions = {
  repoTag: RepoTag;
  env: Env;
  cmd: Command[];
  bindMounts: BindMount[];
  tmpFs: TmpFs;
  boundPorts: BoundPorts;
  name?: ContainerName;
};

export interface DockerClient {
  info(): Promise<DockerInfo>;
  pull(repoTag: RepoTag): Promise<void>;
  create(options: CreateOptions): Promise<Container>;
  start(container: Container): Promise<void>;
  exec(container: Container, command: Command[]): Promise<ExecResult>;
  buildImage(repoTag: RepoTag, context: BuildContext, buildArgs: BuildArgs): Promise<void>;
  fetchRepoTags(): Promise<RepoTag[]>;
  getHost(): Host;
}

export class DockerodeClient implements DockerClient {
  constructor(private readonly host: Host, private readonly dockerode: Dockerode) {}

  public async info(): Promise<DockerInfo> {
    const { Version: version } = await this.dockerode.version();
    const { LayersSize: availableBytes } = await this.dockerode.df();

    return {
      version,
      availableMb: availableBytes / 1e6
    };
  }

  public async pull(repoTag: RepoTag): Promise<void> {
    log.info(`Pulling image: ${repoTag}`);
    const stream = await this.dockerode.pull(repoTag.toString(), {});
    await streamToArray(stream);
  }

  public async create(options: CreateOptions): Promise<Container> {
    log.info(`Creating container for image: ${options.repoTag}`);

    const dockerodeContainer = await this.dockerode.createContainer({
      name: options.name,
      Image: options.repoTag.toString(),
      Env: this.getEnv(options.env),
      ExposedPorts: this.getExposedPorts(options.boundPorts),
      Cmd: options.cmd,
      HostConfig: {
        PortBindings: this.getPortBindings(options.boundPorts),
        Binds: this.getBindMounts(options.bindMounts),
        Tmpfs: options.tmpFs
      }
    });

    return new DockerodeContainer(dockerodeContainer);
  }

  public start(container: Container): Promise<void> {
    log.info(`Starting container with ID: ${container.getId()}`);
    return container.start();
  }

  public async exec(container: Container, command: Command[]): Promise<ExecResult> {
    const exec = await container.exec({
      cmd: command,
      attachStdout: true,
      attachStderr: true
    });

    const stream = await exec.start();
    const output = Buffer.concat(await streamToArray(stream)).toString();
    const { exitCode } = await exec.inspect();

    return { output, exitCode };
  }

  public async buildImage(repoTag: RepoTag, context: BuildContext, buildArgs: BuildArgs): Promise<void> {
    log.info(`Building image '${repoTag.toString()}' with context '${context}'`);

    const tarStream = tar.pack(context);
    const stream = await this.dockerode.buildImage(tarStream, {
      buildargs: buildArgs,
      t: repoTag.toString()
    });
    await streamToArray(stream);
  }

  public async fetchRepoTags(): Promise<RepoTag[]> {
    const images = await this.dockerode.listImages();

    return images.reduce((repoTags: RepoTag[], image) => {
      if (this.isDanglingImage(image)) {
        return repoTags;
      }
      const imageRepoTags = image.RepoTags.map(imageRepoTag => {
        const [imageName, tag] = imageRepoTag.split(":");
        return new RepoTag(imageName, tag);
      });
      return [...repoTags, ...imageRepoTags];
    }, []);
  }

  public getHost(): Host {
    return this.host;
  }

  private isDanglingImage(image: Dockerode.ImageInfo) {
    return image.RepoTags === null;
  }

  private getEnv(env: Env): DockerodeEnvironment {
    return Object.entries(env).reduce(
      (dockerodeEnvironment, [key, value]) => {
        return [...dockerodeEnvironment, `${key}=${value}`];
      },
      [] as DockerodeEnvironment
    );
  }

  private getExposedPorts(boundPorts: BoundPorts): DockerodeExposedPorts {
    const dockerodeExposedPorts: DockerodeExposedPorts = {};
    for (const [internalPort] of boundPorts.iterator()) {
      dockerodeExposedPorts[internalPort.toString()] = {};
    }
    return dockerodeExposedPorts;
  }

  private getPortBindings(boundPorts: BoundPorts): DockerodePortBindings {
    const dockerodePortBindings: DockerodePortBindings = {};
    for (const [internalPort, hostPort] of boundPorts.iterator()) {
      dockerodePortBindings[internalPort.toString()] = [{ HostPort: hostPort.toString() }];
    }
    return dockerodePortBindings;
  }

  private getBindMounts(bindMounts: BindMount[]): DockerodeBindMount[] {
    return bindMounts.map(({ source, target, bindMode }) => `${source}:${target}:${bindMode}`);
  }
}
