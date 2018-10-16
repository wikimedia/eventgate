'use strict';

const P = require('bluebird');
const kafka = require('node-rdkafka');


// TAKEN from
// https://github.com/wikimedia/change-propagation/blob/06178c20779c5ff213dcfdaca92fef0072e0d469/lib/kafka_factory.js
class GuaranteedProducer extends kafka.Producer {
    /**
     * @inheritdoc
     */
    constructor(conf, topicConf) {
        super(conf, topicConf);

        this.on('delivery-report', (err, report) => {
            const reporter = report.opaque;
            if (err) {
                return reporter.rejecter(err);
            }
            return reporter.resolver(report);
        });

        this.on('ready', () => {
            this._pollInterval = setInterval(() => this.poll(), 10);
        });
    }

    /**
     * @inheritdoc
     */
    produce(topic, partition, message, key) {
        return new P((resolve, reject) => {
            const report = {
                resolver: resolve,
                rejecter: reject
            };
            try {
                const result = super.produce(topic, partition, message, key, undefined, report);
                if (result !== true) {
                    process.nextTick(() => {
                        reject(result);
                    });
                }
            } catch (e) {
                process.nextTick(() => {
                    reject(e);
                });
            } finally {
                this.poll();
            }
        });
    }
}

// TODO support creating non guarunteed producer for fire and forget
function createKafkaProducer(config = {}, topicConfig = {}) {
    const defaultConfig = {
        'metadata.broker.list': 'localhost:9092',
        'dr_cb': true
    };

    const defaultTopicConfig = {};

    config = Object.assign(defaultConfig, config);
    topicConfig = Object.assign(defaultTopicConfig, topicConfig);

    return new P((resolve, reject) => {
        const producer = new GuaranteedProducer(defaultConfig, topicConfig);
        producer.once('event.error', reject);
        producer.connect(undefined, (err) => {
            if (err) {
                return reject(err);
            }
            return resolve(producer);
        });
    });
}


class MockProducer {
    /**
     * Return a mock Promise of a node-rdkafka produce delivery report
     */
    produce(topic, partition, message, key) {
        return P.resolve([
            {
                topic,
                partition: 0,
                offset: 1,
                key,
                opaque: { },
                timestamp: 1539629252472,
                size: message.length
            }
        ]);
    }
}
function createMockKafkaProducer(config = {}, topicConfig = {}) {
    return P.resolve(new MockProducer());
}


module.exports = {
    createKafkaProducer,
    createMockKafkaProducer
};
